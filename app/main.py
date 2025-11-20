import asyncio
import tempfile
import time
from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect, Request, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.concurrency import run_in_threadpool
from starlette.responses import FileResponse
from typing import Optional
from pathlib import Path

from .models import AnalyzeRequest, AnalyzeResponse, ExportRequest, ExportTextResponse
from .services import clone_repo_to_session, analyze_repo_path, unpack_zip_to_session
from .utils import safe_filename, session_dir, clean_session, collect_files_for_export, render_markdown_pages, ensure_safe_root

app = FastAPI(title="repo2md")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 세션별로 업로드된 파일 경로를 저장
uploaded_paths = {}

SESSION_TTL_SECONDS = 300
CLEAN_INTERVAL_SECONDS = 300
cleanup_task = None
MD_PAGE_BYTES = 2 * 1024 * 1024

app.mount("/static", StaticFiles(directory="static"), name="static")


async def session_gc_loop():
    """세션 TTL 기반 백그라운드 청소"""
    while True:
        try:
            root = ensure_safe_root()
            now = time.time()
            for d in root.iterdir():
                if not d.is_dir():
                    continue
                try:
                    mtime = d.stat().st_mtime
                except FileNotFoundError:
                    continue
                if now - mtime > SESSION_TTL_SECONDS:
                    clean_session(d.name)
        except Exception as e:
            print(f"❌ 세션 청소 오류: {e}")
        await asyncio.sleep(CLEAN_INTERVAL_SECONDS)


@app.on_event("startup")
async def start_cleanup_task():
    global cleanup_task
    cleanup_task = asyncio.create_task(session_gc_loop())


@app.on_event("shutdown")
async def stop_cleanup_task():
    global cleanup_task
    if cleanup_task:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except Exception:
            pass

@app.get("/")
def index():
    return FileResponse("static/index.html")

@app.get("/config")
def get_config(request: Request):
    base = f"{request.url.scheme}://{request.url.netloc}"
    return {"API_URL": base}


@app.head("/config")
def head_config(request: Request):
    base = f"{request.url.scheme}://{request.url.netloc}"
    return {"API_URL": base}

@app.websocket("/ws/{session_id}")
async def ws_endpoint(websocket: WebSocket, session_id: str):
    await websocket.accept()
    print(f"🔌 WebSocket 연결: {session_id}")
    try:
        while True:
            msg = await websocket.receive_text()
            if msg == "ping":
                await websocket.send_text("pong")
            elif msg == "disconnect":
                print(f"🧹 클라이언트 종료 요청: {session_id}")
                await websocket.close()
                break
    except WebSocketDisconnect:
        print(f"🔌 WebSocket 연결 해제: {session_id}")
    except Exception as e:
        print(f"❌ WebSocket 오류: {e}")
        try:
            await websocket.close()
        except:
            pass
    finally:
        # 연결이 어떤 이유로든 종료되면 세션 폴더 정리
        clean_session(session_id)
        
        # 업로드된 ZIP 파일이 있다면 삭제
        if session_id in uploaded_paths:
            upload_path = uploaded_paths[session_id]
            try:
                if upload_path.exists():
                    upload_path.unlink()
                    print(f"🗑️ 업로드된 ZIP 파일 삭제 완료: {upload_path}")
            except Exception as e:
                print(f"❌ 업로드된 ZIP 파일 삭제 중 오류: {e}")
            # 파일 경로 정보 삭제
            del uploaded_paths[session_id]

        print(f"✅ 세션 정리 완료: {session_id}")

@app.post("/analyze", response_model=AnalyzeResponse)
def analyze_repo(req: AnalyzeRequest, x_session_id: Optional[str] = Header(None)):
    if not x_session_id:
        raise HTTPException(status_code=400, detail="Missing X-Session-Id header")
    session_dir(x_session_id).touch(exist_ok=True)
    try:
        repo_path, repo_name = clone_repo_to_session(x_session_id, req.repo_url)
        data = analyze_repo_path(repo_path, repo_name)
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

# 업로드 스트리밍 저장 유틸
async def save_upload_file(upload: UploadFile, dest: Path, chunk_size: int = 4 * 1024 * 1024) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("wb") as f:
        while True:
            chunk = await upload.read(chunk_size)
            if not chunk:
                break
            f.write(chunk)
    await upload.seek(0)

@app.post("/analyze_zip", response_model=AnalyzeResponse)
async def analyze_zip(file: UploadFile = File(...), x_session_id: Optional[str] = Header(None)):
    if not x_session_id:
        raise HTTPException(status_code=400, detail="Missing X-Session-Id header")
    session_base = session_dir(x_session_id)
    session_base.touch(exist_ok=True)

    # 1) 업로드 ZIP을 고유 이름으로 저장(세션과 연결)
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".zip", prefix=f"repo2md_{x_session_id}_") as tmp:
            upload_path = Path(tmp.name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create temp file: {e}")

    uploaded_paths[x_session_id] = upload_path

    # 2) 저장 (스트리밍)
    try:
        await save_upload_file(file, upload_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save upload: {e}")

    # 3) 저장 확인
    if not upload_path.exists() or upload_path.stat().st_size == 0:
        raise HTTPException(status_code=500, detail="Uploaded ZIP not found after save")

    # 4) 압축 해제 및 분석 (스레드풀로 오프로드)
    try:
        repo_path, repo_name = await run_in_threadpool(unpack_zip_to_session, x_session_id, upload_path)
        data = await run_in_threadpool(analyze_repo_path, repo_path, repo_name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to analyze zip: {e}")
    finally:
        # 5) 업로드 ZIP 즉시 삭제(임시 디렉터리 청소)
        try:
            if upload_path.exists():
                upload_path.unlink()
        except Exception:
            pass
        uploaded_paths.pop(x_session_id, None)

    return data


@app.post("/export/text", response_model=ExportTextResponse)
def export_text(req: ExportRequest, x_session_id: Optional[str] = Header(None)):
    if not x_session_id:
        raise HTTPException(status_code=400, detail="Missing X-Session-Id header")

    session_dir(x_session_id).touch(exist_ok=True)

    base = session_dir(x_session_id)
    repo_dir = base / req.repo_name
    if not repo_dir.exists():
        candidates = [d for d in base.iterdir() if d.is_dir()]
        if not candidates:
            raise HTTPException(status_code=400, detail="Repository not found in session")
        repo_dir = max(candidates, key=lambda d: d.stat().st_mtime)

    files = collect_files_for_export(repo_dir, req.dirs, req.exts, req.files)
    if not files:
        raise HTTPException(status_code=400, detail="No files matched the selection")
    pages = render_markdown_pages(req.repo_name, repo_dir, files, MD_PAGE_BYTES)
    return {
        "paginated": len(pages) > 1,
        "pages": pages,
        "page_size": MD_PAGE_BYTES,
        "total_pages": len(pages)
    }

@app.post("/export/file")
def export_file(req: ExportRequest, x_session_id: Optional[str] = Header(None)):
    if not x_session_id:
        raise HTTPException(status_code=400, detail="Missing X-Session-Id header")

    session_dir(x_session_id).touch(exist_ok=True)

    base = session_dir(x_session_id)
    repo_dir = base / req.repo_name
    if not repo_dir.exists():
        candidates = [d for d in base.iterdir() if d.is_dir()]
        if not candidates:
            raise HTTPException(status_code=400, detail="Repository not found in session")
        repo_dir = max(candidates, key=lambda d: d.stat().st_mtime)

    files = collect_files_for_export(repo_dir, req.dirs, req.exts, req.files)
    if not files:
        raise HTTPException(status_code=400, detail="No files matched the selection")
    pages = render_markdown_pages(req.repo_name, repo_dir, files, MD_PAGE_BYTES)
    filename = f"{req.repo_name}_export.md"

    def page_stream():
        for page in pages:
            yield page.encode("utf-8")

    return StreamingResponse(
        page_stream(),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )
