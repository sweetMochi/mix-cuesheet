"""檢查系統 PATH 上的外部 CLI 工具"""

import shutil
from collections.abc import Callable, Mapping

from pydantic import BaseModel

from app import config

# 依執行檔名稱找出完整路徑，找不到時回傳 None
Which = Callable[[str], str | None]


class ToolStatus(BaseModel):
    name: str
    available: bool


def check_tools(
    tools: Mapping[str, str] = config.REQUIRED_TOOLS,
    which: Which = shutil.which,
) -> list[ToolStatus]:
    return [ToolStatus(name=name, available=which(executable) is not None) for name, executable in tools.items()]
