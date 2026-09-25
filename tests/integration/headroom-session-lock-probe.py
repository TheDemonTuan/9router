"""Exercise the pinned Headroom app's real session lock without provider traffic."""

from fastapi.testclient import TestClient
from headroom.proxy.server import ProxyConfig, create_app


app = create_app(ProxyConfig(
    optimize=True,
    cache_enabled=False,
    rate_limit_enabled=False,
    cost_tracking_enabled=False,
    log_requests=False,
    image_optimize=False,
))
body = {
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Synthetic request"}],
    "config": {"session_id": "synthetic-lock-probe"},
    "gateway": {"can_redrive": False, "can_relay_response": True, "session_affinity": True},
}

with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 12345)) as client:
    first = client.post("/v1/compress", json=body)
    assert first.status_code == 200, first.status_code
    lock = app.state.proxy._compression_caches["compress\x00synthetic-lock-probe"].session_turn_lock
    assert lock.acquire(timeout=1)
    try:
        blocked = client.post("/v1/compress", json=body)
        assert blocked.status_code == 503, blocked.status_code
        assert blocked.json()["error"]["type"] == "compression_timeout"
    finally:
        lock.release()
    retried = client.post("/v1/compress", json=body)
    assert retried.status_code == 200, retried.status_code
    assert retried.json()["body"]["messages"] == first.json()["body"]["messages"]

print('{"sidecarLock":"503_compression_timeout_then_replay"}')
