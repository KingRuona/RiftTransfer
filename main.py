
from __future__ import annotations
from contextlib import contextmanager

import base64
import hashlib
import io
import json
import mimetypes
import os
import secrets
import shutil
import socket
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import qrcode
import uvicorn
from fastapi import FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


# ---------------------------------------------------------
# Paths and settings
# ---------------------------------------------------------

BASE = Path(__file__).resolve().parent
WEB = BASE / "web"
RECEIVED = BASE / "Received"
PARTIALS = RECEIVED / ".partials"
DB_PATH = BASE / "rifttransfer.db"
ADMIN_SECRET_PATH = BASE / ".rift_admin_secret"

HOST = "0.0.0.0"
PORT = 8765
CHUNK_SIZE = 4 * 1024 * 1024
PAIR_CODE_MINUTES = 10

RECEIVED.mkdir(parents=True, exist_ok=True)
PARTIALS.mkdir(parents=True, exist_ok=True)
WEB.mkdir(parents=True, exist_ok=True)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def get_admin_secret() -> str:
    if ADMIN_SECRET_PATH.exists():
        return ADMIN_SECRET_PATH.read_text(encoding="utf-8").strip()

    secret = secrets.token_urlsafe(48)
    ADMIN_SECRET_PATH.write_text(secret, encoding="utf-8")
    try:
        os.chmod(ADMIN_SECRET_PATH, 0o600)
    except OSError:
        pass
    return secret


ADMIN_SECRET = get_admin_secret()

app = FastAPI(title="RiftTransfer", version="2.0")


# ---------------------------------------------------------
# Database
# ---------------------------------------------------------

@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH, timeout=20)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                can_upload INTEGER NOT NULL DEFAULT 1,
                can_download INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                last_seen TEXT
            );

            CREATE TABLE IF NOT EXISTS pair_requests (
                id TEXT PRIMARY KEY,
                secret_hash TEXT NOT NULL,
                name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                device_id TEXT,
                issued_token TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(device_id) REFERENCES devices(id)
                    ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                disk_name TEXT NOT NULL UNIQUE,
                size INTEGER NOT NULL,
                content_type TEXT,
                owner_device_id TEXT,
                target_device_id TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(owner_device_id) REFERENCES devices(id)
                    ON DELETE SET NULL,
                FOREIGN KEY(target_device_id) REFERENCES devices(id)
                    ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_files_owner
                ON files(owner_device_id);

            CREATE INDEX IF NOT EXISTS idx_files_target
                ON files(target_device_id);
            """
        )


init_db()


# Active pairing code and in-progress chunk uploads are held in memory.
pairing_code: Optional[str] = None
pairing_expires: Optional[datetime] = None
upload_sessions: dict[str, dict] = {}


# ---------------------------------------------------------
# Network helpers
# ---------------------------------------------------------

def local_ip() -> str:
    """Find the LAN address used for QR pairing."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        address = sock.getsockname()[0]
        sock.close()
        return address
    except OSError:
        return "127.0.0.1"


def is_loopback(request: Request) -> bool:
    host = request.client.host if request.client else ""
    return host in {"127.0.0.1", "::1", "localhost", "testclient"}


def clean_filename(name: str) -> str:
    # Keep only the filename, never a supplied directory path.
    name = Path(name.replace("\\", "/")).name
    name = "".join(
        char for char in name
        if char.isprintable() and char not in '<>:"/\\|?*'
    ).strip(" .")
    return name[:240] or "untitled-file"


def require_admin(request: Request) -> None:
    supplied = request.headers.get("X-Rift-Admin", "")
    if not supplied or not secrets.compare_digest(supplied, ADMIN_SECRET):
        raise HTTPException(status_code=401, detail="Admin authorization required")


def get_device(
    device_token: Optional[str],
    *,
    upload: bool = False,
    download: bool = False,
) -> sqlite3.Row:
    if not device_token:
        raise HTTPException(status_code=401, detail="Pair this device first")

    with db() as conn:
        device = conn.execute(
            "SELECT * FROM devices WHERE token_hash = ?",
            (sha256(device_token),),
        ).fetchone()

        if not device:
            raise HTTPException(status_code=401, detail="Device access revoked")

        if upload and not device["can_upload"]:
            raise HTTPException(status_code=403, detail="Sending files is disabled for this device")

        if download and not device["can_download"]:
            raise HTTPException(status_code=403, detail="Receiving files is disabled for this device")

        conn.execute(
            "UPDATE devices SET last_seen = ? WHERE id = ?",
            (utc_now(), device["id"]),
        )

        return device


def authenticate(
    request: Request,
    admin_token: Optional[str],
    device_token: Optional[str],
    *,
    upload: bool = False,
    download: bool = False,
) -> tuple[str, Optional[sqlite3.Row]]:
    """Return ('admin', None) or ('device', device_row)."""
    if admin_token and secrets.compare_digest(admin_token, ADMIN_SECRET):
        return "admin", None

    device = get_device(
        device_token,
        upload=upload,
        download=download,
    )
    return "device", device


def public_device(device: sqlite3.Row) -> dict:
    return {
        "id": device["id"],
        "name": device["name"],
        "can_upload": bool(device["can_upload"]),
        "can_download": bool(device["can_download"]),
        "created_at": device["created_at"],
        "last_seen": device["last_seen"],
    }


def get_file_for_user(
    file_id: str,
    role: str,
    device: Optional[sqlite3.Row],
) -> sqlite3.Row:
    with db() as conn:
        item = conn.execute(
            "SELECT * FROM files WHERE id = ?",
            (file_id,),
        ).fetchone()

    if not item:
        raise HTTPException(status_code=404, detail="File not found")

    if role == "admin":
        return item

    # A paired device may access only its own uploads or files
    # explicitly shared with it.
    if item["owner_device_id"] == device["id"]:
        return item

    if item["target_device_id"] == device["id"]:
        return item

    raise HTTPException(status_code=403, detail="This file has not been shared with your device")


# ---------------------------------------------------------
# Request models
# ---------------------------------------------------------

class PairRequestBody(BaseModel):
    code: str
    device_name: str = Field(min_length=1, max_length=80)


class PermissionBody(BaseModel):
    can_upload: bool
    can_download: bool


class ShareBody(BaseModel):
    device_id: str


class UploadStartBody(BaseModel):
    filename: str = Field(min_length=1, max_length=500)
    size: int = Field(ge=0)
    target_device_id: Optional[str] = None


class UploadFinishBody(BaseModel):
    upload_id: str


# ---------------------------------------------------------
# Main page and static assets
# ---------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
def home():
    index = WEB / "index.html"
    if not index.exists():
        return HTMLResponse(
            "<h1>RiftTransfer</h1><p>Place your interface in the web folder.</p>",
            status_code=200,
        )
    return HTMLResponse(index.read_text(encoding="utf-8"))


if WEB.exists():
    app.mount("/web", StaticFiles(directory=WEB), name="web")


@app.get("/api/health")
def health():
    return {"ok": True, "app": "RiftTransfer", "version": "2.0"}


@app.get("/api/info")
def info():
    # Deliberately does NOT reveal the admin or device credentials.
    return {
        "ip": local_ip(),
        "port": PORT,
        "chunk_size": CHUNK_SIZE,
        "pairing_required": True,
    }


@app.get("/api/admin/bootstrap")
def admin_bootstrap(request: Request):
    # Only a browser running on this PC can retrieve the admin secret.
    if not is_loopback(request):
        raise HTTPException(
            status_code=403,
            detail="Open RiftTransfer on this PC using http://127.0.0.1:8765",
        )

    return {
        "admin_token": ADMIN_SECRET,
        "ip": local_ip(),
        "port": PORT,
    }


# ---------------------------------------------------------
# Pairing: PC creates QR; phone requests access; PC approves
# ---------------------------------------------------------

@app.get("/api/admin/pairing")
def create_pairing(request: Request, x_rift_admin: Optional[str] = Header(None)):
    require_admin(request)

    global pairing_code, pairing_expires
    pairing_code = secrets.token_urlsafe(9)
    pairing_expires = datetime.now(timezone.utc) + timedelta(minutes=PAIR_CODE_MINUTES)

    url = f"http://{local_ip()}:{PORT}/?pair={pairing_code}"

    qr = qrcode.make(url)
    buffer = io.BytesIO()
    qr.save(buffer, format="PNG")
    qr_data = base64.b64encode(buffer.getvalue()).decode("ascii")

    return {
        "code": pairing_code,
        "expires_at": pairing_expires.isoformat(),
        "url": url,
        "qr_data": f"data:image/png;base64,{qr_data}",
    }


@app.post("/api/pair/request")
def request_pairing(body: PairRequestBody):
    global pairing_code, pairing_expires

    now = datetime.now(timezone.utc)
    if (
        not pairing_code
        or not pairing_expires
        or now > pairing_expires
        or not secrets.compare_digest(body.code, pairing_code)
    ):
        raise HTTPException(status_code=400, detail="Pairing code expired or invalid. Scan a fresh QR code.")

    request_id = uuid.uuid4().hex
    pair_secret = secrets.token_urlsafe(32)

    with db() as conn:
        conn.execute(
            """
            INSERT INTO pair_requests
                (id, secret_hash, name, status, created_at)
            VALUES (?, ?, ?, 'pending', ?)
            """,
            (
                request_id,
                sha256(pair_secret),
                body.device_name.strip()[:80],
                utc_now(),
            ),
        )

    return {
        "request_id": request_id,
        "pair_secret": pair_secret,
        "status": "pending",
        "message": "Waiting for approval on the RiftTransfer PC.",
    }


@app.get("/api/pair/status/{request_id}")
def pairing_status(
    request_id: str,
    x_rift_pair_secret: Optional[str] = Header(None),
):
    if not x_rift_pair_secret:
        raise HTTPException(status_code=401, detail="Pairing request credential missing")

    with db() as conn:
        request_row = conn.execute(
            "SELECT * FROM pair_requests WHERE id = ?",
            (request_id,),
        ).fetchone()

        if (
            not request_row
            or not secrets.compare_digest(
                request_row["secret_hash"],
                sha256(x_rift_pair_secret),
            )
        ):
            raise HTTPException(status_code=404, detail="Pairing request not found")

        if request_row["status"] == "pending":
            return {"status": "pending"}

        if request_row["status"] == "rejected":
            return {"status": "rejected"}

        if request_row["status"] == "approved" and request_row["issued_token"]:
            token = request_row["issued_token"]
            conn.execute(
                "UPDATE pair_requests SET issued_token = NULL WHERE id = ?",
                (request_id,),
            )
            return {
                "status": "approved",
                "device_token": token,
                "device_id": request_row["device_id"],
            }

        return {"status": "approved", "message": "Device already paired. If this is a new browser, request pairing again."}


@app.get("/api/admin/pair-requests")
def list_pair_requests(request: Request, x_rift_admin: Optional[str] = Header(None)):
    require_admin(request)

    with db() as conn:
        rows = conn.execute(
            """
            SELECT id, name, status, created_at
            FROM pair_requests
            WHERE status = 'pending'
            ORDER BY created_at ASC
            """
        ).fetchall()

    return {"requests": [dict(row) for row in rows]}


@app.post("/api/admin/pair-requests/{request_id}/approve")
def approve_pair_request(
    request_id: str,
    request: Request,
    x_rift_admin: Optional[str] = Header(None),
):
    require_admin(request)

    token = secrets.token_urlsafe(40)
    device_id = uuid.uuid4().hex

    with db() as conn:
        pair_req = conn.execute(
            "SELECT * FROM pair_requests WHERE id = ? AND status = 'pending'",
            (request_id,),
        ).fetchone()

        if not pair_req:
            raise HTTPException(status_code=404, detail="Pending request not found")

        conn.execute(
            """
            INSERT INTO devices
                (id, name, token_hash, can_upload, can_download, created_at, last_seen)
            VALUES (?, ?, ?, 1, 1, ?, ?)
            """,
            (
                device_id,
                pair_req["name"],
                sha256(token),
                utc_now(),
                utc_now(),
            ),
        )

        conn.execute(
            """
            UPDATE pair_requests
            SET status = 'approved', device_id = ?, issued_token = ?
            WHERE id = ?
            """,
            (device_id, token, request_id),
        )

    return {"ok": True, "device_id": device_id}


@app.post("/api/admin/pair-requests/{request_id}/reject")
def reject_pair_request(
    request_id: str,
    request: Request,
    x_rift_admin: Optional[str] = Header(None),
):
    require_admin(request)

    with db() as conn:
        result = conn.execute(
            """
            UPDATE pair_requests
            SET status = 'rejected', issued_token = NULL
            WHERE id = ? AND status = 'pending'
            """,
            (request_id,),
        )

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Pending request not found")

    return {"ok": True}


# ---------------------------------------------------------
# Device management and permissions
# ---------------------------------------------------------

@app.get("/api/admin/devices")
def list_devices(request: Request, x_rift_admin: Optional[str] = Header(None)):
    require_admin(request)

    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM devices ORDER BY created_at DESC"
        ).fetchall()

    return {"devices": [public_device(row) for row in rows]}


@app.get("/api/devices/me")
def my_device(x_rift_device_token: Optional[str] = Header(None)):
    device = get_device(x_rift_device_token)
    return {"device": public_device(device)}


@app.patch("/api/admin/devices/{device_id}/permissions")
def update_device_permissions(
    device_id: str,
    body: PermissionBody,
    request: Request,
    x_rift_admin: Optional[str] = Header(None),
):
    require_admin(request)

    with db() as conn:
        result = conn.execute(
            """
            UPDATE devices
            SET can_upload = ?, can_download = ?
            WHERE id = ?
            """,
            (int(body.can_upload), int(body.can_download), device_id),
        )

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Device not found")

    return {"ok": True}


@app.delete("/api/admin/devices/{device_id}")
def revoke_device(
    device_id: str,
    request: Request,
    x_rift_admin: Optional[str] = Header(None),
):
    require_admin(request)

    with db() as conn:
        result = conn.execute(
            "DELETE FROM devices WHERE id = ?",
            (device_id,),
        )

        # Do not leave stale file shares pointing at a revoked device.
        conn.execute(
            "UPDATE files SET target_device_id = NULL WHERE target_device_id = ?",
            (device_id,),
        )

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Device not found")

    return {"ok": True}


# ---------------------------------------------------------
# Uploads: chunked transfer, 4 MiB per chunk
# ---------------------------------------------------------

@app.post("/api/upload/start")
def upload_start(
    body: UploadStartBody,
    request: Request,
    x_rift_admin: Optional[str] = Header(None),
    x_rift_device_token: Optional[str] = Header(None),
):
    role, device = authenticate(
        request,
        x_rift_admin,
        x_rift_device_token,
        upload=True,
    )

    target_id = body.target_device_id if role == "admin" else None

    if target_id:
        with db() as conn:
            target = conn.execute(
                "SELECT id, can_download FROM devices WHERE id = ?",
                (target_id,),
            ).fetchone()

        if not target:
            raise HTTPException(status_code=404, detail="Target device not found")
        if not target["can_download"]:
            raise HTTPException(status_code=403, detail="That device cannot receive files")

    upload_id = uuid.uuid4().hex
    upload_dir = PARTIALS / upload_id
    upload_dir.mkdir(parents=True, exist_ok=False)

    upload_sessions[upload_id] = {
        "filename": clean_filename(body.filename),
        "size": body.size,
        "owner_device_id": device["id"] if device else None,
        "target_device_id": target_id,
        "upload_dir": str(upload_dir),
        "chunks": set(),
    }

    return {
        "upload_id": upload_id,
        "chunk_size": CHUNK_SIZE,
        "chunks_expected": (body.size + CHUNK_SIZE - 1) // CHUNK_SIZE,
    }


@app.put("/api/upload/chunk/{upload_id}/{chunk_index}")
async def upload_chunk(
    upload_id: str,
    chunk_index: int,
    request: Request,
    x_rift_admin: Optional[str] = Header(None),
    x_rift_device_token: Optional[str] = Header(None),
):
    authenticate(
        request,
        x_rift_admin,
        x_rift_device_token,
        upload=True,
    )

    session = upload_sessions.get(upload_id)
    if not session:
        raise HTTPException(status_code=404, detail="Upload session expired or not found")

    if chunk_index < 0:
        raise HTTPException(status_code=400, detail="Invalid chunk index")

    data = await request.body()
    if len(data) > CHUNK_SIZE:
        raise HTTPException(status_code=413, detail="Chunk exceeds maximum size")

    chunk_path = Path(session["upload_dir"]) / f"{chunk_index:08d}.chunk"
    chunk_path.write_bytes(data)
    session["chunks"].add(chunk_index)

    return {"ok": True, "chunk": chunk_index, "bytes": len(data)}


@app.post("/api/upload/finish")
def upload_finish(
    body: UploadFinishBody,
    request: Request,
    x_rift_admin: Optional[str] = Header(None),
    x_rift_device_token: Optional[str] = Header(None),
):
    role, device = authenticate(
        request,
        x_rift_admin,
        x_rift_device_token,
        upload=True,
    )

    session = upload_sessions.get(body.upload_id)
    if not session:
        raise HTTPException(status_code=404, detail="Upload session expired or not found")

    # Ensure the same device/admin that started the upload finishes it.
    expected_owner = device["id"] if device else None
    if session["owner_device_id"] != expected_owner:
        raise HTTPException(status_code=403, detail="Upload belongs to another session")

    expected_chunks = (
        session["size"] + CHUNK_SIZE - 1
    ) // CHUNK_SIZE

    missing = [
        index for index in range(expected_chunks)
        if index not in session["chunks"]
    ]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Upload incomplete: {len(missing)} chunk(s) missing",
        )

    disk_name = f"{uuid.uuid4().hex}.bin"
    final_path = RECEIVED / disk_name
    upload_dir = Path(session["upload_dir"])

    try:
        with final_path.open("wb") as output:
            for index in range(expected_chunks):
                chunk_path = upload_dir / f"{index:08d}.chunk"
                with chunk_path.open("rb") as chunk:
                    shutil.copyfileobj(chunk, output)

        if final_path.stat().st_size != session["size"]:
            final_path.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="File size validation failed")

        file_id = uuid.uuid4().hex
        filename = session["filename"]
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"

        with db() as conn:
            conn.execute(
                """
                INSERT INTO files
                    (id, filename, disk_name, size, content_type,
                     owner_device_id, target_device_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    file_id,
                    filename,
                    disk_name,
                    session["size"],
                    content_type,
                    session["owner_device_id"],
                    session["target_device_id"],
                    utc_now(),
                ),
            )

        return {
            "ok": True,
            "file_id": file_id,
            "filename": filename,
            "size": session["size"],
        }

    finally:
        shutil.rmtree(upload_dir, ignore_errors=True)
        upload_sessions.pop(body.upload_id, None)


# ---------------------------------------------------------
# File list, sharing, and secure downloads
# ---------------------------------------------------------

@app.get("/api/files")
def list_files(
    request: Request,
    x_rift_admin: Optional[str] = Header(None),
    x_rift_device_token: Optional[str] = Header(None),
):
    role, device = authenticate(request, x_rift_admin, x_rift_device_token)

    with db() as conn:
        if role == "admin":
            rows = conn.execute(
                "SELECT * FROM files ORDER BY created_at DESC"
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT * FROM files
                WHERE owner_device_id = ? OR target_device_id = ?
                ORDER BY created_at DESC
                """,
                (device["id"], device["id"]),
            ).fetchall()

    return {
        "files": [
            {
                "id": row["id"],
                "filename": row["filename"],
                "size": row["size"],
                "content_type": row["content_type"],
                "owner_device_id": row["owner_device_id"],
                "target_device_id": row["target_device_id"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]
    }


@app.post("/api/admin/files/{file_id}/share")
def share_file(
    file_id: str,
    body: ShareBody,
    request: Request,
    x_rift_admin: Optional[str] = Header(None),
):
    require_admin(request)

    with db() as conn:
        target = conn.execute(
            "SELECT id, can_download FROM devices WHERE id = ?",
            (body.device_id,),
        ).fetchone()

        if not target:
            raise HTTPException(status_code=404, detail="Device not found")
        if not target["can_download"]:
            raise HTTPException(status_code=403, detail="Receiving is disabled for that device")

        result = conn.execute(
            "UPDATE files SET target_device_id = ? WHERE id = ?",
            (body.device_id, file_id),
        )

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="File not found")

    return {"ok": True}


@app.delete("/api/admin/files/{file_id}/share")
def unshare_file(
    file_id: str,
    request: Request,
    x_rift_admin: Optional[str] = Header(None),
):
    require_admin(request)

    with db() as conn:
        result = conn.execute(
            "UPDATE files SET target_device_id = NULL WHERE id = ?",
            (file_id,),
        )

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="File not found")

    return {"ok": True}


@app.get("/api/download/{file_id}")
def download_file(
    file_id: str,
    request: Request,
    x_rift_admin: Optional[str] = Header(None),
    x_rift_device_token: Optional[str] = Header(None),
):
    role, device = authenticate(
        request,
        x_rift_admin,
        x_rift_device_token,
        download=(not bool(x_rift_admin)),
    )

    item = get_file_for_user(file_id, role, device)
    disk_path = RECEIVED / item["disk_name"]

    if not disk_path.is_file():
        raise HTTPException(status_code=404, detail="File data is missing")

    return FileResponse(
        path=disk_path,
        filename=item["filename"],
        media_type=item["content_type"] or "application/octet-stream",
    )


@app.delete("/api/admin/files/{file_id}")
def delete_file(
    file_id: str,
    request: Request,
    x_rift_admin: Optional[str] = Header(None),
):
    require_admin(request)

    with db() as conn:
        item = conn.execute(
            "SELECT disk_name FROM files WHERE id = ?",
            (file_id,),
        ).fetchone()

        if not item:
            raise HTTPException(status_code=404, detail="File not found")

        conn.execute("DELETE FROM files WHERE id = ?", (file_id,))

    (RECEIVED / item["disk_name"]).unlink(missing_ok=True)
    return {"ok": True}


# ---------------------------------------------------------
# Run
# ---------------------------------------------------------

if __name__ == "__main__":
    print()
    print("RiftTransfer is starting...")
    print(f"On this PC: http://127.0.0.1:{PORT}")
    print(f"On your Wi-Fi: http://{local_ip()}:{PORT}")
    print("The admin secret is stored in .rift_admin_secret.")
    print("Keep that file private. Do not send it to paired devices.")
    print()

    uvicorn.run(app, host=HOST, port=PORT)
