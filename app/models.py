# app/models.py
from pydantic import BaseModel
from typing import List, Optional, Literal, Any

class AnalyzeRequest(BaseModel):
    repo_url: str

class ExportRequest(BaseModel):
    repo_name: str
    exts: List[str]
    dirs: List[str]
    files: Optional[List[str]] = None

class TreeNode(BaseModel):
    name: str
    path: str
    type: Literal["directory", "file"]
    children: Optional[List["TreeNode"]] = None

TreeNode.model_rebuild()

class AnalyzeResponse(BaseModel):
    repo_name: str
    extensions: List[str]
    dirs_tree: TreeNode

class ExportTextResponse(BaseModel):
    paginated: bool
    pages: List[str]
    page_size: int
    total_pages: int
