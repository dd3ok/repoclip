# Repoclip

Git 저장소를 분석하여 전체 구조와 코드 내용을 하나의 마크다운 또는 텍스트로 변환하는 웹 애플리케이션입니다. Repoclip으로 생성된 파일은 LLM 컨텍스트, 코드 리뷰, 프로젝트 문서화 등 다양한 용도로 활용할 수 있습니다.

## 주요 기능

- **원격 저장소 분석**: Git URL을 입력하면 서버에서 저장소를 클론하고 파일 구조를 분석합니다.
- **세부 필터링**: UI를 통해 출력에 포함할 파일 확장자 및 디렉토리를 선택할 수 있습니다.
- **다양한 출력**: 분석 결과를 Markdown 파일 또는 텍스트 형식으로 내보낼 수 있습니다.
- **자동 리소스 관리**: WebSocket 기반으로 사용자 세션을 관리하며, 연결이 종료되면 서버의 임시 파일을 자동으로 삭제하여 리소스를 효율적으로 사용합니다.

## 기술 스택

- **Backend**: Python, FastAPI, Uvicorn
- **Frontend**: Vanilla JavaScript, HTML, CSS
- **Communication**: HTTP, WebSocket
- **Core Logic**: `subprocess` (Git 연동), `pathlib` (파일 시스템)

## 프로젝트 구조
```
repoclip/
├── app/
│ ├── main.py # API 엔드포인트, WebSocket 서버
│ ├── services.py # 저장소 분석/내보내기 핵심 로직
│ ├── utils.py # Git 클론, 트리 생성 등 유틸리티
│ └── models.py # Pydantic 데이터 모델
├── static/
│ └── index.html # 사용자 인터페이스 (프론트엔드)
├── repos/
│ └── (클론된 저장소가 임시로 생성되는 곳)
├── pyproject.toml
├── requirements.txt
└── README.md
```

## 설치 및 실행

**요구사항**: Python 3.13 이상, Git

1.  **저장소 클론**
    ```
    git clone https://github.com/your-username/repoclip.git
    cd repoclip
    ```

2.  **가상 환경 생성 및 활성화**
    ```
    # Windows
    python -m venv .venv
    .venv\Scripts\activate

    # macOS / Linux
    python3 -m venv .venv
    source .venv/bin/activate
    ```

3.  **의존성 패키지 설치**
    ```
    pip install -r requirements.txt
    ```

4.  **Uvicorn 서버 실행**
    ```
    uvicorn app.main:app --reload
    ```

5.  **서비스 접속**
    웹 브라우저에서 `http://127.0.0.1:8000` 주소로 접속합니다.

## API 엔드포인트

- `GET /config`
  - 서버의 API 기본 URL 설정을 반환합니다.

- `POST /analyze`
  - Git 저장소를 분석하고 파일 구조 정보를 반환합니다.
  - **Header**: `X-Session-Id`
  - **Body**: `{ "repo_url": "..." }`

- `POST /export/file`
  - 선택된 옵션을 바탕으로 Markdown 파일을 생성하여 반환합니다.
  - 대용량도 스트리밍으로 전송되며, 클라이언트는 즉시 다운로드 시작 가능합니다.
  - **Header**: `X-Session-Id`
  - **Body**: `{ "repo_name": "...", "exts": [...], "dirs": [...] }`

- `POST /export/text`
  - 선택된 옵션을 바탕으로 Markdown 텍스트를 생성하여 반환합니다.
  - 응답 스키마: `{ paginated: bool, pages: string[], page_size: number, total_pages: number }`
    - 기본 페이지 크기: 약 2MB 기준으로 분할하며 1페이지일 경우 `paginated=false`.
    - 브라우저는 `pages` 배열을 순서대로 화면에 그리거나, 필요 시 전체를 합쳐 사용 가능합니다.

- `WS /ws/{session_id}`
  - 클라이언트 세션 유지를 위한 WebSocket 엔드포인트입니다.
