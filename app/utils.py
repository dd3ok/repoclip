import os
import re
import shutil
import zipfile
from pathlib import Path
from typing import Dict, List, Set, Tuple

# 제외 대상 정의
EXCLUDED_DIRS = {
    ".git", ".github", ".gitlab", ".svn", ".hg", "__pycache__", ".mypy_cache", ".pytest_cache",
    ".idea", ".vscode", "node_modules", "dist", "build", "out", ".next", ".nuxt", ".expo",
    ".parcel-cache", ".sass-cache", ".cache", "coverage", "target", "bin", "obj", ".gradle",
    ".terraform", ".serverless"
}

EXCLUDED_FILES = {
    ".DS_Store", "Thumbs.db", "desktop.ini"
}

EXCLUDED_FILE_TYPES = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".ico", ".icns",  # 바이너리 이미지
    ".jar", ".war", ".ear", ".class", ".pyc", ".pyo",                  # 빌드/컴파일 산출물
    ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz",                      # 아카이브
    ".log", ".tmp", ".swp", ".swo",                                   # 로그/임시
    ".lock", ".env.local", ".env.production", ".env.development"       # 잠금/환경
}

# 프로젝트 루트에 .repos 디렉토리를 생성하여 임시 파일들을 안전하게 관리
SAFE_ROOT = Path(os.getenv("REPOCLIP_ROOT", ".repos")).resolve()

def ensure_safe_root() -> Path:
    """SAFE_ROOT 디렉토리가 존재하는지 확인하고 없으면 생성합니다."""
    SAFE_ROOT.mkdir(parents=True, exist_ok=True)
    return SAFE_ROOT


def is_within_base(path: Path, base: Path) -> bool:
    """경로 탈출 여부 확인"""
    try:
        return base == path or base in path.parents
    except Exception:
        return False

def session_dir_path(session_id: str) -> Path:
    root = ensure_safe_root()
    d = (root / session_id).resolve()
    if root not in d.parents and d != root:
        raise ValueError("Invalid session path")
    return d

def session_dir(session_id: str) -> Path:
    # 작업용: 필요 시 생성
    d = session_dir_path(session_id)
    d.mkdir(parents=True, exist_ok=True)
    return d

def clean_session(session_id: str) -> None:
    """세션 ID에 해당하는 작업 디렉토리를 완전히 삭제한다(재생성 안 함)."""
    try:
        d = session_dir_path(session_id)  # 생성하지 않음
        if d.exists():
            import stat
            def handle_remove_readonly(func, path, exc):
                try:
                    os.chmod(path, stat.S_IWRITE)
                except Exception:
                    pass
                func(path)
            shutil.rmtree(d, onerror=handle_remove_readonly)
            print(f"✅ 세션 {session_id} 정리 완료: {d}")
        else:
            print(f"⚠️ 세션 {session_id} 디렉토리 없음: {d}")
    except Exception as e:
        print(f"❌ 세션 {session_id} 정리 중 오류: {e}")

def guess_repo_name_from_git_url(url: str) -> str:
    """Git URL에서 저장소 이름을 추측합니다."""
    base = url.strip().rstrip("/").split("/")[-1]
    if base.endswith(".git"):
        base = base[:-4]
    return base or "repository"

def list_files_and_extensions(base_dir: Path) -> Tuple[Dict, List[str]]:
    """
    지정된 디렉토리의 파일 구조 트리와 사용된 확장자 목록을 반환합니다.
    (기존 코드의 중복 로직을 제거하여 리팩토링됨)
    """
    extensions: Set[str] = set()

    def walk(current: Path) -> Dict:
        """재귀적으로 디렉토리를 탐색하며 트리 노드를 생성합니다."""
        entries: List[Path] = []
        for p in current.iterdir():
            name = p.name
            # 심볼릭 링크는 무시 (경로 탈출/루프 방지)
            if p.is_symlink():
                continue
            if name.startswith(".") and name not in {".gitignore", ".env.example", ".env.sample"}:
                continue
            if p.is_dir() and name in EXCLUDED_DIRS:
                continue
            if p.is_file() and (name in EXCLUDED_FILES or p.suffix in EXCLUDED_FILE_TYPES):
                continue

            # base_dir 밖으로 나가면 제외
            try:
                if not is_within_base(p.resolve(), base_dir.resolve()):
                    continue
            except FileNotFoundError:
                continue
            entries.append(p)

        entries = sorted(entries, key=lambda p: (p.is_file(), p.name.lower()))
        
        children: List[Dict] = []
        for p in entries:
            if p.is_dir():
                child = walk(p)
                if child is not None:
                    children.append(child)
            else:
                ext = p.suffix
                if ext:
                    extensions.add(ext)
                children.append({
                    "name": p.name,
                    "path": str(p.relative_to(base_dir)).replace("\\", "/"),
                    "type": "file"
                })

        # 빈 디렉터리는 표시하지 않음 (루트 제외)
        if current != base_dir and not children:
            return None

        return {
            "name": current.name,
            "path": str(current.relative_to(base_dir)).replace("\\", "/") if current != base_dir else "",
            "type": "directory",
            "children": children
        }

    tree = walk(base_dir)
    # 확장자 목록을 정렬하여 반환
    return tree, sorted(list(extensions))


def unzip_to(dir_path: Path, zip_file_path: Path) -> Path:
    if not zip_file_path.exists():
        raise FileNotFoundError(f"ZIP not found: {zip_file_path}")
    if zip_file_path.stat().st_size == 0:
        raise FileNotFoundError(f"ZIP empty: {zip_file_path}")

    dir_path.mkdir(parents=True, exist_ok=True)
    base_resolved = dir_path.resolve()

    def is_symlink_zipinfo(info: zipfile.ZipInfo) -> bool:
        return (info.external_attr >> 16) & 0o170000 == 0o120000

    with zipfile.ZipFile(zip_file_path, 'r') as zf:
        for member in zf.infolist():
            # Zip-Slip, symlink 방지
            if is_symlink_zipinfo(member):
                continue
            member_path = Path(member.filename)
            if member_path.is_absolute():
                continue
            target_path = (dir_path / member_path).resolve()
            if not is_within_base(target_path, base_resolved):
                continue

            if member.is_dir():
                target_path.mkdir(parents=True, exist_ok=True)
                continue

            target_path.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(member, 'r') as source, target_path.open('wb') as dest:
                shutil.copyfileobj(source, dest)

    entries = [p for p in dir_path.iterdir() if not p.name.startswith(("__MACOSX", "."))]
    if len(entries) == 1 and entries[0].is_dir():
        return entries[0]
    return dir_path

def collect_files_for_export(
    base_dir: Path,
    selected_dirs: List[str],
    selected_exts: List[str],
    selected_files: List[str] = None
) -> List[Path]:
    """사용자가 선택한 디렉토리/확장자 또는 명시적 파일 목록에 맞는 파일 목록을 수집합니다."""
    files_to_export: List[Path] = []
    
    # 선택된 디렉토리 목록을 set으로 변환하여 검색 성능 향상
    selected_dirs_set = set(d.strip("/") for d in selected_dirs)
    selected_files_set = set(f.strip("/") for f in (selected_files or []))

    def is_in_selected_dir(rel_path: str) -> bool:
        # 아무 디렉토리도 선택하지 않으면 전체를 의미
        if not selected_dirs_set:
            return True
        # 루트("")가 선택되었으면 전체를 의미
        if "" in selected_dirs_set:
            return True

        # 파일의 경로가 선택된 디렉토리 중 하나에 포함되는지 확인
        return any(rel_path == d or rel_path.startswith(d + "/") for d in selected_dirs_set)

    def is_allowed_file(path_obj: Path) -> bool:
        name = path_obj.name
        rel_parts = path_obj.relative_to(base_dir).parts
        if path_obj.is_symlink():
            return False
        if any(part in EXCLUDED_DIRS or (part.startswith(".") and part not in {".gitignore", ".env.example", ".env.sample"}) for part in rel_parts[:-1]):
            return False
        if name.startswith(".") and name not in {".gitignore", ".env.example", ".env.sample"}:
            return False
        if name in EXCLUDED_FILES or path_obj.suffix in EXCLUDED_FILE_TYPES:
            return False
        try:
            if not is_within_base(path_obj.resolve(), base_dir.resolve()):
                return False
        except FileNotFoundError:
            return False
        return True

    # 파일 목록이 명시되었으면, 그 목록만 우선적으로 처리
    if selected_files_set:
        for rel_path in selected_files_set:
            candidate = base_dir / rel_path
            if not candidate.exists() or not candidate.is_file():
                continue
            if not is_allowed_file(candidate):
                continue
            files_to_export.append(candidate)
        return sorted(files_to_export, key=lambda x: str(x).lower())

    # 명시적 파일이 없으면 기존 디렉터리/확장자 선택 로직 사용
    for p in base_dir.rglob("*"):
        if p.is_file():
            if not is_allowed_file(p):
                continue

            rel_path_str = str(p.relative_to(base_dir)).replace("\\", "/")

            if not is_in_selected_dir(rel_path_str):
                continue
            # 확장자 필터링 (선택된 확장자가 있을 경우에만)
            if selected_exts and p.suffix not in selected_exts:
                continue

            files_to_export.append(p)

    return sorted(files_to_export, key=lambda x: str(x).lower())

def _tree_lines(base_dir: Path, files: List[Path]) -> List[str]:
    rel_paths = [f.relative_to(base_dir).as_posix() for f in files]

    def build_tree_structure(paths: List[str]) -> Dict:
        root = {"name": f"{base_dir.name}/", "children": {}, "is_file": False}
        for p in paths:
            parts = p.split("/")
            node = root
            for i, part in enumerate(parts):
                is_file = (i == len(parts) - 1)
                key = (part, is_file)
                if key not in node.get("children", {}):
                    node.setdefault("children", {})[key] = {"name": part, "children": {}, "is_file": is_file}
                node = node["children"][key]
        return root

    def emit_tree(node: Dict, prefix: str = "", acc: List[str] = None):
        if acc is None:
            acc = []
        children_items = sorted(node.get("children", {}).items(), key=lambda kv: (kv[0][1], kv[0][0].lower()))
        for idx, ((name, is_file), child) in enumerate(children_items):
            connector = "└── " if idx == len(children_items) - 1 else "├── "
            acc.append(f"{prefix}{connector}{name}")
            if not is_file and child.get("children"):
                new_prefix = prefix + ("    " if idx == len(children_items) - 1 else "│   ")
                emit_tree(child, new_prefix, acc)
        return acc

    tree_root = build_tree_structure(rel_paths)
    tree_lines = emit_tree(tree_root, acc=[])
    return ["## Project Tree", "```", *tree_lines, "```", ""]


def render_markdown_pages(repo_name: str, base_dir: Path, files: List[Path], max_page_bytes: int) -> List[str]:
    """선택된 파일을 2MB(기본) 단위로 페이지화하되, 파일 단위로 잘라서 페이지를 구성"""
    if not files:
        return ["\n".join([f"# {repo_name}", "", "_선택된 파일이 없습니다._"])]

    def block_size(lines: List[str]) -> int:
        return sum(len(line.encode("utf-8")) + 1 for line in lines)  # newline 포함

    pages: List[List[str]] = []
    current: List[str] = []
    current_bytes = 0

    def flush_page():
        nonlocal current, current_bytes
        if current:
            pages.append(current)
            current = []
            current_bytes = 0

    def add_block(block: List[str]):
        nonlocal current_bytes
        size = block_size(block)
        # 현재 페이지에 여유가 없으면 새 페이지 시작 (파일 단위 보장)
        if current and current_bytes + size > max_page_bytes:
            flush_page()
        current.extend(block)
        current_bytes += size

    # 프롤로그 + 트리 (가능하면 첫 페이지에 유지)
    preamble = [
        f"# {repo_name}", "",
        "Treat the project tree and source code below as the single source of truth for this session.",
        "Create an internal structured summary of the repository and rely on it for all answers.",
        "All responses must stay fully consistent with the codebase—do not invent details not present here.",
        "If I provide updated files later, update your internal model and briefly describe the changes.",
        ""
    ]

    preamble.extend(_tree_lines(base_dir, files))
    add_block(preamble)

    # 파일 블록은 파일 단위로 페이지를 넘김
    add_block(["## Files"])
    for f in files:
        rel_path = str(f.relative_to(base_dir)).replace("\\", "/")
        file_block = [f"### `{rel_path}`"]
        lang = f.suffix.lstrip('.')
        file_block.append(f"```{lang}")
        try:
            content = f.read_text(encoding="utf-8", errors="replace")
            file_block.append(content)
        except Exception:
            file_block.append("<binary or unreadable file>")
        file_block.append("```")
        file_block.append("")

        # 파일 단위로 넘어가기: 현재 페이지 여유 없으면 먼저 flush
        add_block(file_block)
        # 만약 단일 파일 블록이 max_page_bytes를 초과하면 그대로 들어가도록 허용 (줄단위 쪼개기 지양)

    flush_page()

    if not pages:
        return [""]
    return ["\n".join(p) for p in pages]

def safe_filename(name: str) -> str:
    name = name.strip()
    name = re.sub(r"[^\w.\-]+", "_", name)
    return name or "upload.zip"
