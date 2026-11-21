from fastapi.testclient import TestClient

from app.main import app, get_tool_statuses
from app.tools import ToolStatus, check_tools


def client_with_tools(*statuses: ToolStatus) -> TestClient:
    app.dependency_overrides[get_tool_statuses] = lambda: list(statuses)
    return TestClient(app)


def teardown_function() -> None:
    app.dependency_overrides.clear()


def test_health_reports_ok_when_all_tools_available() -> None:
    client = client_with_tools(
        ToolStatus(name="yt-dlp", available=True),
        ToolStatus(name="FFmpeg", available=True),
    )

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "tools": [
            {"name": "yt-dlp", "available": True},
            {"name": "FFmpeg", "available": True},
        ],
    }


def test_health_reports_which_tool_is_missing() -> None:
    client = client_with_tools(
        ToolStatus(name="yt-dlp", available=True),
        ToolStatus(name="FFmpeg", available=False),
    )

    body = client.get("/api/health").json()

    assert body["ok"] is False
    assert {"name": "FFmpeg", "available": False} in body["tools"]


def test_check_tools_looks_up_each_executable_on_path() -> None:
    on_path = {"yt-dlp": "/usr/bin/yt-dlp"}

    statuses = check_tools({"yt-dlp": "yt-dlp", "FFmpeg": "ffmpeg"}, which=on_path.get)

    assert statuses == [
        ToolStatus(name="yt-dlp", available=True),
        ToolStatus(name="FFmpeg", available=False),
    ]
