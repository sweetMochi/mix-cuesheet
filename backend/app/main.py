import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app import config
from app.tools import ToolStatus, check_tools

# 借用 uvicorn 的 logger，讓訊息格式與伺服器其他 log 一致
logger = logging.getLogger("uvicorn.error")


class HealthResponse(BaseModel):
    ok: bool
    tools: list[ToolStatus]


def get_tool_statuses() -> list[ToolStatus]:
    return check_tools()


api = APIRouter(prefix="/api")


@api.get("/health")
def health(tools: Annotated[list[ToolStatus], Depends(get_tool_statuses)]) -> HealthResponse:
    return HealthResponse(ok=all(tool.available for tool in tools), tools=tools)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    missing = [tool.name for tool in check_tools() if not tool.available]
    if missing:
        logger.warning("系統 PATH 上找不到：%s", "、".join(missing))
    yield


app = FastAPI(title="mix-cuesheet", lifespan=lifespan)
app.include_router(api)

# 平常使用時由後端直接提供 Angular build 後的靜態檔；開發時改用 ng serve
if config.FRONTEND_DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=config.FRONTEND_DIST_DIR, html=True), name="frontend")
