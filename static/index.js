// static/index.js

let API_BASE_URL = null;
const sessionId = crypto.randomUUID(); // ✅ 세션 단위 repo 관리
let ws = null; // ✅ WebSocket 객체

// 서버에서 환경설정 불러오기
async function loadConfig() {
    try {
        const res = await fetch("/config");
        if (!res.ok) throw new Error("Config fetch failed");
        const cfg = await res.json();
        API_BASE_URL = cfg.API_URL;
        console.log("✅ Loaded API BASE URL:", API_BASE_URL);
    } catch (e) {
        console.error("❌ Failed to load config:", e);
        API_BASE_URL = "http://127.0.0.1:8000"; // fallback
    }
}

// 웹소켓 연결 함수 수정
function connectWebSocket() {
    const wsProtocol = (window.location.protocol === "https:") ? "wss://" : "ws://";
    ws = new WebSocket(`${wsProtocol}${window.location.host}/ws/${sessionId}`);

    ws.onopen = () => { 
        console.log("🔌 WebSocket 연결됨:", sessionId); 
    };
    
    ws.onmessage = (event) => {
        if (event.data === "pong") console.log("서버 pong 수신");
    };
    
    ws.onclose = () => { 
        console.log("❌ WebSocket 닫힘"); 
        // 연결이 끊어지면 재연결 시도하지 않음 (세션 종료로 간주)
    };
    
    ws.onerror = (error) => {
        console.error("WebSocket 에러:", error);
    };

    // 30초마다 ping (연결 유지 확인)
    const pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send("ping");
        } else {
            clearInterval(pingInterval);
        }
    }, 30000);
}

// 탭 닫기 또는 새로고침 시 소켓 이벤트 발생
window.addEventListener("beforeunload", (event) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send("disconnect");
        ws.close();
    }
});

window.addEventListener("pagehide", (event) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send("disconnect");
        ws.close();
    }
});

// ✅ 초기화 실행
loadConfig().then(() => {
    connectWebSocket();

    // DOM 캐시
    const dom = {
        // 공통
        errorMessage: document.getElementById('error-message'),
        errorToast: document.getElementById('error-toast'),
        errorClose: document.getElementById('error-close'),
        analysisResult: document.getElementById('analysis-result'),
        repoNameDisplay: document.getElementById('repo-name-display'),
        extsContainer: document.getElementById('exts-container'),
        extsSelectAll: document.getElementById('exts-select-all'),
        treeContainer: document.getElementById('tree-container'),
        exportTextBtn: document.getElementById('export-text-btn'),
        exportFileBtn: document.getElementById('export-file-btn'),
        modalOverlay: document.getElementById('modal-overlay'),
        modalClose: document.getElementById('modal-close'),
        markdownPreview: document.getElementById('markdown-preview'),
        copyButton: document.getElementById('copy-button'),
        copyAllButton: document.getElementById('copy-all-button'),
        prevPageBtn: document.getElementById('prev-page'),
        nextPageBtn: document.getElementById('next-page'),
        pageIndicator: document.getElementById('page-indicator'),

        // Git URL 분석
        analyzeForm: document.getElementById('analyze-form'),
        analyzeBtn: document.getElementById('analyze-btn'),
        repoUrlInput: document.getElementById('repo-url-input'),

        // ZIP 업로드 분석
        analyzeZipForm: document.getElementById('analyze-zip-form'),
        analyzeZipBtn: document.getElementById('analyze-zip-btn'),
        repoZipInput: document.getElementById('repo-zip-input'),
        zipProgress: document.getElementById('zip-progress'),
        fileNameDisplay: document.getElementById('file-name-display'),
    };

    if (dom.analyzeZipBtn) {
        dom.analyzeZipBtn.disabled = true;
    }

    let analysisData = {};
    let previewPages = [];
    let currentPageIndex = 0;
    let errorHideTimer = null;

    // 유틸
    function setLoading(button, isLoading) {
        if (!button) return;
        const buttonText = button.querySelector('span');
        if (isLoading) {
            button.disabled = true;
            if (buttonText) buttonText.style.display = 'none';
            const loader = document.createElement('div');
            loader.className = 'loader';
            button.prepend(loader);
        } else {
            button.disabled = false;
            const loader = button.querySelector('.loader');
            if (loader) loader.remove();
            if (buttonText) buttonText.style.display = 'inline';
        }
    }

    function showError(message) {
        // 새 토스트 알럿으로 에러 안내
        if (!dom.errorToast || !dom.errorMessage) {
            console.error('Error element missing:', message);
            alert(message);
            return;
        }

        dom.errorMessage.textContent = message;
        dom.errorToast.classList.add('show');

        if (errorHideTimer) clearTimeout(errorHideTimer);
        errorHideTimer = setTimeout(() => {
            hideError();
        }, 6000);
    }
    function hideError() {
        if (!dom.errorToast) return;
        dom.errorToast.classList.remove('show');
        if (dom.errorMessage) dom.errorMessage.textContent = '';
        if (errorHideTimer) {
            clearTimeout(errorHideTimer);
            errorHideTimer = null;
        }
    }

    if (dom.errorClose) {
        dom.errorClose.addEventListener('click', hideError);
    }

    function renderPreviewPage() {
        if (!dom.markdownPreview) return;
        if (!previewPages || previewPages.length === 0) {
            dom.markdownPreview.textContent = '';
            return;
        }
        dom.markdownPreview.textContent = previewPages[currentPageIndex] || '';

        const total = previewPages.length;
        const isPaged = total > 1;
        const controls = [dom.prevPageBtn, dom.nextPageBtn, dom.pageIndicator, dom.copyAllButton];
        controls.forEach(el => { if (el) el.style.display = isPaged ? 'inline-block' : 'none'; });

        if (dom.pageIndicator) dom.pageIndicator.textContent = `${currentPageIndex + 1} / ${total}`;
        if (dom.prevPageBtn) dom.prevPageBtn.disabled = currentPageIndex === 0;
        if (dom.nextPageBtn) dom.nextPageBtn.disabled = currentPageIndex >= total - 1;
    }

    function setPreviewPages(pages) {
        previewPages = Array.isArray(pages) && pages.length ? pages : [''];
        currentPageIndex = 0;
        renderPreviewPage();
    }

    function createExtCheckbox(id, value, checked = true) {
        const wrapper = document.createElement('div');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'ext-checkbox';
        checkbox.id = id;
        checkbox.value = value;
        checkbox.checked = checked;
        const labelEl = document.createElement('label');
        labelEl.htmlFor = id;
        labelEl.textContent = value;
        wrapper.appendChild(checkbox);
        wrapper.appendChild(labelEl);
        return wrapper;
    }

    function renderInteractiveTree(node, container, isRoot = false) {
        if (node.type === 'directory') {
            if (isRoot) {
                const block = document.createElement('div');
                block.className = 'tree-root-block';

                const header = document.createElement('div');
                header.className = 'tree-root-header';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.value = node.path;
                checkbox.checked = true;
                checkbox.dataset.type = 'directory';
                checkbox.dataset.root = 'true';

                const span = document.createElement('span');
                span.className = 'dir-item';
                span.textContent = node.name;

                header.appendChild(checkbox);
                header.appendChild(span);
                block.appendChild(header);

                if (node.children?.length > 0) {
                    const childWrapper = document.createElement('div');
                    childWrapper.className = 'tree-children';
                    node.children.forEach(child => renderInteractiveTree(child, childWrapper));
                    block.appendChild(childWrapper);
                }

                container.appendChild(block);
                return;
            }

            const details = document.createElement('details');
            details.className = 'tree-directory';
            details.open = true;
            details.dataset.treeNode = 'directory';

            const summary = document.createElement('summary');
            summary.className = 'tree-summary';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = node.path;
            checkbox.checked = true;
            checkbox.dataset.type = 'directory';
            checkbox.addEventListener('click', (e) => e.stopPropagation());

            const span = document.createElement('span');
            span.className = 'dir-item';
            span.textContent = node.name;

            summary.appendChild(checkbox);
            summary.appendChild(span);
            details.appendChild(summary);

            if (node.children?.length > 0) {
                const childWrapper = document.createElement('div');
                childWrapper.className = 'tree-children';
                node.children.forEach(child => renderInteractiveTree(child, childWrapper));
                details.appendChild(childWrapper);
            }

            container.appendChild(details);
        } else {
            const row = document.createElement('div');
            row.className = 'tree-leaf';
            row.dataset.treeNode = 'file';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = node.path;
            checkbox.checked = true;
            checkbox.dataset.type = 'file';

            const span = document.createElement('span');
            span.className = 'file-item';
            span.textContent = node.name;

            row.appendChild(checkbox);
            row.appendChild(span);
            container.appendChild(row);
        }
    }

    function syncExtensionsFromTree() {
        if (!dom.treeContainer) return;
        const allExtCheckboxes = dom.extsContainer.querySelectorAll('.ext-checkbox');
        const allChecked = Array.from(allExtCheckboxes).every(cb => cb.checked);
        dom.extsSelectAll.checked = allChecked;
    }

    function refreshDirectoryStates() {
        if (!dom.treeContainer) return;
        const directories = dom.treeContainer.querySelectorAll('.tree-directory');
        directories.forEach(dir => {
            const parentCheckbox = dir.querySelector('summary input[type="checkbox"]');
            if (!parentCheckbox) return;
            const childCheckboxes = dir.querySelectorAll('.tree-children input[type="checkbox"]');
            if (childCheckboxes.length === 0) {
                parentCheckbox.indeterminate = false;
                return;
            }
            const childArray = Array.from(childCheckboxes);
            const allChecked = childArray.every(cb => cb.checked);
            const anyChecked = childArray.some(cb => cb.checked);
            parentCheckbox.checked = allChecked;
            parentCheckbox.indeterminate = !allChecked && anyChecked;
        });

        const rootHeader = dom.treeContainer.querySelector('.tree-root-header input[type="checkbox"]');
        const rootChildren = dom.treeContainer.querySelectorAll('.tree-root .tree-children input[type="checkbox"]');
        if (rootHeader && rootChildren.length > 0) {
            const childArray = Array.from(rootChildren);
            const allChecked = childArray.every(cb => cb.checked);
            const anyChecked = childArray.some(cb => cb.checked);
            rootHeader.checked = allChecked;
            rootHeader.indeterminate = !allChecked && anyChecked;
        }
    }

    function pruneEmptyDirectories(node) {
        if (!node || node.type !== 'directory') return node;
        const prunedChildren = [];
        if (Array.isArray(node.children)) {
            node.children.forEach(child => {
                if (child.type === 'directory') {
                    const pruned = pruneEmptyDirectories(child);
                    if (pruned && pruned.children && pruned.children.length > 0) {
                        prunedChildren.push(pruned);
                    }
                } else {
                    prunedChildren.push(child);
                }
            });
        }
        node.children = prunedChildren;
        return (node.children && node.children.length > 0) || node.path === '' ? node : null;
    }

    function renderAnalysis(data) {
        analysisData = data;
        if (dom.repoNameDisplay) {
            dom.repoNameDisplay.textContent = analysisData.repo_name || '';
        }

        // 확장자 렌더
        dom.extsContainer.innerHTML = '';
        (analysisData.extensions || []).forEach((ext, i) => {
            dom.extsContainer.appendChild(createExtCheckbox(`ext-${i}`, ext));
        });
        dom.extsSelectAll.checked = true;

        // 트리 렌더
        dom.treeContainer.innerHTML = '';
        if (analysisData.dirs_tree) {
            const root = document.createElement('div');
            root.className = 'tree-root';
            const pruned = pruneEmptyDirectories(analysisData.dirs_tree);
            if (pruned) {
                renderInteractiveTree(pruned, root, true);
            }
            dom.treeContainer.appendChild(root);
            refreshDirectoryStates();
        }

        dom.analysisResult.style.display = 'flex';
    }

    async function handleExport(type) {
        const selectedExts = Array.from(dom.extsContainer.querySelectorAll('.ext-checkbox:checked')).map(el => el.value);
        const selectedDirs = Array.from(dom.treeContainer.querySelectorAll('input[data-type="directory"]:checked')).map(el => el.value);
        const selectedFiles = Array.from(dom.treeContainer.querySelectorAll('input[data-type="file"]:checked')).map(el => el.value);
        const exportBtn = (type === 'text') ? dom.exportTextBtn : dom.exportFileBtn;
        setLoading(exportBtn, true);
        try {
            const response = await fetch(`${API_BASE_URL}/export/${type}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
                body: JSON.stringify({
                    repo_name: analysisData.repo_name,
                    exts: selectedExts,
                    dirs: selectedDirs,
                    files: selectedFiles,
                })
            });
            if (!response.ok) throw new Error((await response.json()).detail || '내보내기에 실패했습니다.');
            if (type === 'file') {
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.style.display = 'none'; a.href = url;
                const contentDisposition = response.headers.get('content-disposition');
                let filename = `${analysisData.repo_name || 'repo'}_export.md`;
                if (contentDisposition) {
                    const match = contentDisposition.match(/filename="?([^"]+)"?/);
                    if (match && match.length > 1) filename = match[1];
                }
                a.download = filename;
                document.body.appendChild(a); a.click();
                window.URL.revokeObjectURL(url); a.remove();
            } else {
                const data = await response.json();
                const pages = (data.pages && data.pages.length) ? data.pages : (data.content ? [data.content] : []);
                if (!pages.length) {
                    throw new Error('선택된 파일이 없거나 빈 결과입니다.');
                }
                setPreviewPages(pages);
                if (dom.modalOverlay) {
                    dom.modalOverlay.style.display = 'flex';
                }
            }
        } catch (error) {
            showError(`내보내기 오류: ${error.message}`);
        } finally {
            setLoading(exportBtn, false);
        }
    }

    // ZIP 파일 선택 및 업로드 분석 폼 제출 (통합)
    if (dom.repoZipInput && dom.fileNameDisplay && dom.analyzeZipBtn && dom.analyzeZipForm) {
        // 파일 선택 인풋 변경 이벤트
        dom.repoZipInput.addEventListener('change', function() {
            const fileInput = this;
            const fileNameDisplay = dom.fileNameDisplay;
            const analyzeBtn = dom.analyzeZipBtn;
            
            if (fileInput.files && fileInput.files.length > 0) {
                const selectedFile = fileInput.files[0];
                
                // 파일명을 표시 인풋에 설정
                fileNameDisplay.value = selectedFile.name;
                
                // ZIP 파일인지 검증
                if (selectedFile.name.toLowerCase().endsWith('.zip')) {
                    // 업로드 후 분석 버튼 활성화
                    analyzeBtn.disabled = false;
                    hideError();
                } else {
                    // ZIP이 아닌 경우 에러 표시 및 버튼 비활성화
                    showError('ZIP 확장자(.zip) 파일만 업로드 가능합니다.');
                    analyzeBtn.disabled = true;
                }
            } else {
                // 파일이 선택되지 않은 경우
                fileNameDisplay.value = '';
                fileNameDisplay.placeholder = 'ZIP 파일을 선택해주세요';
                analyzeBtn.disabled = true;
            }
        });

        // 파일명 표시 인풋 클릭시 파일 선택 다이얼로그 열기
        dom.fileNameDisplay.addEventListener('click', function() {
            dom.repoZipInput.click();
        });
        
        // ZIP 업로드 분석 폼 제출 이벤트
        dom.analyzeZipForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            hideError();
            
            const file = dom.repoZipInput.files[0];
            if (!file) {
                showError('파일을 선택해주세요.');
                return;
            }
            
            setLoading(dom.analyzeZipBtn, true);
            dom.analysisResult.style.display = 'none';
            dom.zipProgress.style.display = 'block';

            try {
                const formData = new FormData();
                formData.append('file', file);

                const response = await fetch(`${API_BASE_URL}/analyze_zip`, {
                    method: 'POST',
                    headers: { 'X-Session-Id': sessionId },
                    body: formData
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.detail || 'ZIP 분석에 실패했습니다.');
                }
                
                const data = await response.json();
                renderAnalysis(data);
                
                // 분석 완료 후 폼 리셋
                dom.fileNameDisplay.value = '';
                dom.fileNameDisplay.placeholder = 'ZIP 파일을 선택해주세요';
                dom.analyzeZipBtn.disabled = true;
                dom.repoZipInput.value = '';
                
            } catch (error) {
                showError(`오류: ${error.message}`);
            } finally {
                dom.zipProgress.style.display = 'none';
                setLoading(dom.analyzeZipBtn, false);
            }
        });
    }
    
    // 기존: Git URL 분석
    dom.analyzeForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideError();
        setLoading(dom.analyzeBtn, true);
        dom.analysisResult.style.display = 'none';
        try {
            const response = await fetch(`${API_BASE_URL}/analyze`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
                body: JSON.stringify({ repo_url: dom.repoUrlInput.value })
            });
            if (!response.ok) throw new Error((await response.json()).detail || '분석에 실패했습니다.');
            const data = await response.json();
            renderAnalysis(data);
        } catch (error) {
            showError(`오류: ${error.message}`);
        } finally {
            setLoading(dom.analyzeBtn, false);
        }
    });

    // 트리 → 확장자 sync
    if (dom.treeContainer) {
        dom.treeContainer.addEventListener('change', (e) => {
            if (e.target.type !== 'checkbox') return;
            const nodeType = e.target.dataset.type;
            const isRoot = e.target.dataset.root === 'true';
            if (nodeType === 'directory') {
                const dirNode = e.target.closest('.tree-directory');
                if (dirNode) {
                    const childCheckboxes = dirNode.querySelectorAll('.tree-children input[type="checkbox"]');
                    childCheckboxes.forEach(child => {
                        child.checked = e.target.checked;
                        child.indeterminate = false;
                    });
                } else {
                    const rootBlock = e.target.closest('.tree-root-block');
                    if (rootBlock) {
                        const childCheckboxes = rootBlock.querySelectorAll('.tree-children input[type="checkbox"]');
                        childCheckboxes.forEach(child => {
                            child.checked = e.target.checked;
                            child.indeterminate = false;
                        });
                    }
                }
                if (isRoot) {
                    dom.extsContainer.querySelectorAll('.ext-checkbox').forEach(cb => {
                        cb.checked = e.target.checked;
                    });
                    dom.extsSelectAll.checked = e.target.checked;
                }
            }
            refreshDirectoryStates();
            syncExtensionsFromTree();
        });
    }

    // 확장자 → 트리 sync
    dom.extsContainer.addEventListener('change', (e) => {
        if (e.target.classList.contains('ext-checkbox')) {
            const extCheckbox = e.target;
            const extension = extCheckbox.value;
            const isChecked = extCheckbox.checked;
            const allFileCheckboxes = dom.treeContainer.querySelectorAll('input[data-type="file"]');
            allFileCheckboxes.forEach(fileCheckbox => {
                if (fileCheckbox.value.endsWith(extension)) {
                    fileCheckbox.checked = isChecked;
                }
            });
            refreshDirectoryStates();
            const allExts = dom.extsContainer.querySelectorAll('.ext-checkbox');
            const allChecked = Array.from(allExts).every(cb => cb.checked);
            dom.extsSelectAll.checked = allChecked;
        }
    });

    // 전체 선택
    dom.extsSelectAll.addEventListener('change', () => {
        const isChecked = dom.extsSelectAll.checked;
        dom.extsContainer.querySelectorAll('.ext-checkbox').forEach(cb => { cb.checked = isChecked; });
        if (dom.treeContainer) {
            dom.treeContainer.querySelectorAll('input[data-type="file"]').forEach(cb => { cb.checked = isChecked; });
            dom.treeContainer.querySelectorAll('input[data-type="directory"]').forEach(cb => { cb.checked = isChecked; });
            refreshDirectoryStates();
        }
    });

    // Export 버튼들
    if (dom.exportTextBtn) dom.exportTextBtn.addEventListener('click', () => handleExport('text'));
    if (dom.exportFileBtn) dom.exportFileBtn.addEventListener('click', () => handleExport('file'));

    // 모달/클립보드
    if (dom.modalClose && dom.modalOverlay) {
        dom.modalClose.addEventListener('click', () => { dom.modalOverlay.style.display = 'none'; });
    }
    if (dom.copyButton && dom.markdownPreview) {
        dom.copyButton.addEventListener('click', () => {
            const text = dom.markdownPreview.textContent || '';
            navigator.clipboard.writeText(text).then(() => {
                dom.copyButton.textContent = '복사 완료!';
                setTimeout(() => { dom.copyButton.textContent = '클립보드에 복사하기'; }, 2000);
            }, () => {
                dom.copyButton.textContent = '복사 실패';
                setTimeout(() => { dom.copyButton.textContent = '클립보드에 복사하기'; }, 2000);
            });
        });
    }
    if (dom.copyAllButton) {
        dom.copyAllButton.addEventListener('click', () => {
            const text = (previewPages || []).join('\n\n');
            navigator.clipboard.writeText(text).then(() => {
                dom.copyAllButton.textContent = '전체 복사 완료!';
                setTimeout(() => { dom.copyAllButton.textContent = '전체 복사'; }, 2000);
            }, () => {
                dom.copyAllButton.textContent = '복사 실패';
                setTimeout(() => { dom.copyAllButton.textContent = '전체 복사'; }, 2000);
            });
        });
    }
    if (dom.prevPageBtn) {
        dom.prevPageBtn.addEventListener('click', () => {
            if (currentPageIndex > 0) {
                currentPageIndex -= 1;
                renderPreviewPage();
            }
        });
    }
    if (dom.nextPageBtn) {
        dom.nextPageBtn.addEventListener('click', () => {
            if (previewPages && currentPageIndex < previewPages.length - 1) {
                currentPageIndex += 1;
                renderPreviewPage();
            }
        });
    }
    if (dom.modalOverlay) {
        dom.modalOverlay.addEventListener('click', (e) => {
            if (e.target === dom.modalOverlay) dom.modalOverlay.style.display = 'none';
        });
    }
});
