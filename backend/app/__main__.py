"""以 `python -m app` 啟動後端，主機與連接埠取自設定模組"""

import uvicorn

from app import config

uvicorn.run("app.main:app", host=config.HOST, port=config.PORT)
