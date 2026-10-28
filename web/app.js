const $ = (id) => document.getElementById(id);

const state = {
  info: null,
  adminToken: sessionStorage.getItem("rift_admin_token"),
  deviceToken: localStorage.getItem("rift_device_token"),
  device: null,
  devices: [],
  pending: [],
  files: [],
  chosenFiles: [],
  chunkSize: 4 * 1024 * 1024,
  busy: false,
  toastTimer: null,
};

const PAGE_TITLES = {
  home: "Overview",
  send: "Send files",
  receive: "Receive files",
  devices: "Devices",
  history: "Transfer history",
};

function isLoopback() {
  return ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
}

function setNotice(message, isError = false) {
  const notice = $("notice");
  if (!notice) return;

  notice.textContent = message;
  notice.classList.toggle("error", isError);
  notice.classList.toggle("hidden", !message);
}

function showToast(message, isError = false) {
  let toast = $("rift-toast");

  if (!toast) {
    toast = document.createElement("div");
    toast.id = "rift-toast";
    toast.className = "toast";
    toast.setAttribute("role", "status");
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");

  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
}

function authHeaders(extra = {}) {
  const headers = { ...extra };

  if (state.adminToken) {
    headers["X-Rift-Admin"] = state.adminToken;
  } else if (state.deviceToken) {
    headers["X-Rift-Device-Token"] = state.deviceToken;
  }

  return headers;
}

async function request(url, options = {}) {
  const headers = authHeaders(options.headers || {});

  if (
    options.body &&
    typeof options.body === "string" &&
    !headers["Content-Type"]
  ) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed (${response.status})`);
  }

  if (response.status === 204) return null;

  const type = response.headers.get("content-type") || "";
  return type.includes("application/json") ? response.json() : response;
}

function humanSize(bytes) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(Number(bytes)) / Math.log(1024)),
    units.length - 1,
  );

  return `${(Number(bytes) / 1024 ** index).toFixed(index ? 2 : 0)} ${units[index]}`;
}

function fileSymbol(filename = "") {
  const ext = filename.split(".").pop().toLowerCase();

  if (["png", "jpg", "jpeg", "gif", "webp", "heic", "svg"].includes(ext))
    return "▧";
  if (["mp4", "mov", "mkv", "avi", "webm"].includes(ext)) return "▷";
  if (["doc", "docx", "txt", "rtf", "pdf"].includes(ext)) return "▤";
  if (["zip", "rar", "7z", "gz"].includes(ext)) return "▱";

  return "▤";
}

function formatDate(value) {
  if (!value) return "Date unavailable";

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function showPage(name) {
  const page = PAGE_TITLES[name] ? name : "home";

  document.querySelectorAll(".page").forEach((element) => {
    element.classList.toggle("active-page", element.id === `page-${page}`);
    element.classList.toggle("active", element.id === `page-${page}`);
  });

  document.querySelectorAll("[data-page]").forEach((element) => {
    element.classList.toggle("active", element.dataset.page === page);
  });

  if ($("page-title")) $("page-title").textContent = PAGE_TITLES[page];

  if (page === "receive") refreshFiles().catch(showError);
  if (page === "devices") refreshDevices().catch(showError);
  if (page === "history") refreshFiles().catch(showError);
  if (page === "home") refreshDashboard().catch(showError);

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showError(error) {
  console.error(error);
  showToast(error.message || "Something went wrong.", true);
}

document.querySelectorAll("[data-page]").forEach((element) => {
  element.addEventListener("click", (event) => {
    event.preventDefault();
    showPage(element.dataset.page);
  });
});

document.querySelectorAll("[data-go]").forEach((element) => {
  element.addEventListener("click", () => showPage(element.dataset.go));
});

function setConnection(label, network) {
  if ($("connection-label")) $("connection-label").textContent = label;
  if ($("network-label")) $("network-label").textContent = network;
}

function setPairingMode() {
  const adminOnlyElements = [
    "generate-qr",
    "pending-requests",
    "paired-devices",
    "refresh-pending",
  ];

  adminOnlyElements.forEach((id) => {
    const element = $(id);
    if (element) element.classList.toggle("hidden", !state.adminToken);
  });
}

async function bootstrapAdmin() {
  if (!isLoopback()) return false;

  try {
    const data = await request("/api/admin/bootstrap", {
      method: "GET",
      headers: {},
    });

    const secret =
      data.admin_token || data.admin_secret || data.secret || data.token;

    if (!secret) return false;

    state.adminToken = secret;
    sessionStorage.setItem("rift_admin_token", secret);
    return true;
  } catch (error) {
    console.warn("Admin bootstrap unavailable:", error.message);
    return false;
  }
}

async function beginPairing(code) {
  setNotice("Requesting approval from the RiftTransfer PC…");

  const deviceName =
    (
      prompt(
        "Give this device a name:",
        /iPhone|iPad/i.test(navigator.userAgent)
          ? "My iPhone"
          : /Android/i.test(navigator.userAgent)
            ? "My Android phone"
            : "My device",
      ) || "My device"
    )
      .trim()
      .slice(0, 80) || "My device";

  try {
    const result = await request("/api/pair/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        device_name: deviceName,
      }),
    });

    const requestId = result.request_id;
    const pairSecret = result.pair_secret;

    if (!requestId || !pairSecret) {
      throw new Error("The server returned an incomplete pairing response.");
    }

    history.replaceState({}, "", location.pathname);

    setNotice("Pairing request sent. Approve this device on the PC.");

    let finished = false;

    while (!finished) {
      await new Promise((resolve) => setTimeout(resolve, 1800));

      const status = await request(
        `/api/pair/status/${encodeURIComponent(requestId)}`,
        {
          method: "GET",
          headers: { "X-Rift-Pair-Secret": pairSecret },
        },
      );

      const value = String(status.status || "pending").toLowerCase();

      if (["approved", "paired", "complete", "completed"].includes(value)) {
        const deviceToken =
          status.device_token || status.token || status.issued_token;

        if (!deviceToken) {
          throw new Error(
            "The PC approved this device, but the server did not return its device token. Pair again.",
          );
        }

        state.deviceToken = deviceToken;
        localStorage.setItem("rift_device_token", deviceToken);

        if (status.device_id != null) {
          localStorage.setItem("rift_device_id", String(status.device_id));
        }

        setNotice("Device approved. Connecting…");
        finished = true;
        location.reload();
      } else if (["rejected", "denied"].includes(value)) {
        setNotice("The pairing request was rejected on the PC.", true);
        finished = true;
      } else if (["expired", "cancelled", "canceled"].includes(value)) {
        setNotice(
          "This pairing request expired. Scan a newly generated QR code.",
          true,
        );
        finished = true;
      }
    }
  } catch (error) {
    setNotice(`Pairing failed: ${error.message}`, true);
    showToast(error.message, true);
  }
}

async function loadIdentity() {
  if (state.adminToken) {
    try {
      const data = await request("/api/admin/devices");
      state.devices = Array.isArray(data) ? data : data.devices || [];
      return "admin";
    } catch {
      state.adminToken = null;
      sessionStorage.removeItem("rift_admin_token");
    }
  }

  if (state.deviceToken) {
    try {
      state.device = await request("/api/devices/me");
      return "device";
    } catch {
      state.deviceToken = null;
      localStorage.removeItem("rift_device_token");
      localStorage.removeItem("rift_device_id");
    }
  }

  return "guest";
}

function configureGuestMode() {
  if ($("stat-devices")) $("stat-devices").textContent = "0";
  if ($("stat-files")) $("stat-files").textContent = "0";

  if ($("start-send")) {
    $("start-send").disabled = true;
  }

  setNotice(
    "This device is not paired. Open the PC dashboard at http://127.0.0.1:8765 and generate a pairing QR code.",
    true,
  );
}

async function initialize() {
  const oldToken = new URLSearchParams(location.search).get("token");

  // The old query-string token mechanism is no longer used.
  if (oldToken) {
    history.replaceState({}, "", location.pathname);
  }

  const info = await request("/api/info", { headers: {} });
  state.info = info;
  state.chunkSize = Number(info.chunk_size) || state.chunkSize;

  const pairingCode = new URLSearchParams(location.search).get("pair");
  if (pairingCode) {
    await beginPairing(pairingCode);
    return;
  }

  if (isLoopback() && !state.adminToken) {
    await bootstrapAdmin();
  }

  const role = await loadIdentity();

  const address = `${info.ip || location.hostname}:${info.port || 8765}`;
  setConnection(
    role === "admin"
      ? "PC admin"
      : role === "device"
        ? "Device paired"
        : "Not paired",
    address,
  );

  if (role === "guest") {
    setNotice(
      "This device is not paired. Open RiftTransfer on the PC and scan a fresh pairing QR code.",
    );
  } else {
    setNotice("");
  }

  setPairingMode();

  if (role === "guest") {
    // Do not request protected files before pairing.
    configureGuestMode();
    return;
  }

  await refreshDashboard();
  await refreshFiles();

  if (role === "admin") {
    await refreshDevices();
    await generateTargetOptions();
  } else {
    configureDeviceMode();
  }

  // Keep the dashboard fresh while it remains open.
  window.setInterval(async () => {
    try {
      await refreshDashboard();
      if (state.adminToken) await refreshDevices();
      await refreshFiles();
    } catch (error) {
      console.warn("Background refresh failed:", error.message);
    }
  }, 7000);
}

function configureDeviceMode() {
  const target = $("send-target");
  if (target) {
    target.innerHTML = "";
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Send to this RiftTransfer PC";
    target.appendChild(option);
    target.disabled = true;
  }

  const roleCanUpload = Boolean(
    state.device?.can_upload ?? state.device?.permissions?.can_upload,
  );

  const roleCanDownload = Boolean(
    state.device?.can_download ?? state.device?.permissions?.can_download,
  );

  if ($("start-send")) $("start-send").disabled = !roleCanUpload;

  if (!roleCanUpload) {
    setNotice(
      "This device does not currently have permission to upload files to the PC.",
    );
  } else if (!roleCanDownload) {
    setNotice(
      "Uploads are allowed. Downloads require the PC administrator to enable download permission.",
    );
  }
}

async function refreshDashboard() {
  if ($("stat-ip")) {
    $("stat-ip").textContent = state.info
      ? `${state.info.ip || "Local network"}:${state.info.port || 8765}`
      : "—";
  }

  if (state.adminToken) {
    const [devicesResult, pendingResult, filesResult] = await Promise.all([
      request("/api/admin/devices"),
      request("/api/admin/pair-requests"),
      request("/api/files"),
    ]);

    state.devices = Array.isArray(devicesResult)
      ? devicesResult
      : devicesResult.devices || [];

    state.pending = Array.isArray(pendingResult)
      ? pendingResult
      : pendingResult.requests || pendingResult.pending || [];

    state.files = Array.isArray(filesResult)
      ? filesResult
      : filesResult.files || [];

    updateStats();
    renderPendingPreview();
    renderRecentFiles();
    updatePendingBadge();
  } else if (state.deviceToken) {
    const result = await request("/api/files");
    state.files = Array.isArray(result) ? result : result.files || [];
    updateStats();
    renderRecentFiles();
  } else {
    updateStats();
  }
}

function updateStats() {
  if ($("stat-devices")) {
    $("stat-devices").textContent = state.adminToken
      ? String(state.devices.length)
      : state.device
        ? "1"
        : "0";
  }

  if ($("stat-files")) $("stat-files").textContent = String(state.files.length);
}

function updatePendingBadge() {
  const count = state.pending.length;

  if ($("pending-count")) $("pending-count").textContent = String(count);

  if ($("pending-badge")) {
    $("pending-badge").textContent = String(count);
    $("pending-badge").classList.toggle("hidden", count === 0);
  }
}

async function generateTargetOptions() {
  const select = $("send-target");
  if (!select) return;

  const previous = select.value;
  select.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose an approved device";
  select.appendChild(placeholder);

  state.devices.forEach((device) => {
    const option = document.createElement("option");
    option.value = String(device.id);
    option.textContent = device.name || `Device ${device.id}`;
    select.appendChild(option);
  });

  if (state.devices.some((device) => String(device.id) === previous)) {
    select.value = previous;
  }
}

async function generatePairingQR() {
  if (!state.adminToken) {
    showToast(
      "Open the admin dashboard on the PC using http://127.0.0.1:8765.",
      true,
    );
    return;
  }

  try {
    const data = await request("/api/admin/pairing", { method: "GET" });

    const image = $("pair-qr");
    const placeholder = $("qr-placeholder");
    const qrData = data.qr_data || data.qr || data.qr_code;
    const code = data.code || data.pairing_code;

    if (image && qrData) {
      image.src = qrData;
      image.classList.remove("hidden");
    }

    if (placeholder) placeholder.classList.toggle("hidden", Boolean(qrData));

    if ($("pair-code-label")) {
      $("pair-code-label").textContent = code
        ? `Pairing code: ${code}`
        : "QR code generated";
    }

    if ($("pair-expiry")) {
      $("pair-expiry").textContent = data.expires_at
        ? `Expires ${formatDate(data.expires_at)}`
        : "This code expires after a short time.";
    }

    showToast("A new pairing QR code is ready.");
  } catch (error) {
    showError(error);
  }
}

$("generate-qr")?.addEventListener("click", generatePairingQR);

async function refreshDevices() {
  if (!state.adminToken) return;

  const [devicesResult, pendingResult] = await Promise.all([
    request("/api/admin/devices"),
    request("/api/admin/pair-requests"),
  ]);

  state.devices = Array.isArray(devicesResult)
    ? devicesResult
    : devicesResult.devices || [];

  state.pending = Array.isArray(pendingResult)
    ? pendingResult
    : pendingResult.requests || pendingResult.pending || [];

  renderDevices();
  renderPendingRequests();
  updatePendingBadge();
  updateStats();
  await generateTargetOptions();
}

function makeButton(label, className, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className || "button secondary";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function makeEmpty(message) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  return empty;
}

function renderPendingPreview() {
  const container = $("pending-preview");
  if (!container) return;

  container.replaceChildren();

  if (!state.pending.length) {
    container.appendChild(makeEmpty("No devices waiting for approval."));
    return;
  }

  const requestItem = state.pending[0];
  const copy = document.createElement("p");
  copy.textContent = `${requestItem.name || "A device"} is waiting for approval.`;
  container.appendChild(copy);

  container.appendChild(
    makeButton("Review request", "button secondary", () => showPage("devices")),
  );
}


function renderRecentFiles() {
  const container = $("recent-files");
  if (!container) return;

  const files = Array.isArray(state.files) ? state.files : [];
  container.replaceChildren();

  if (files.length === 0) {
    container.appendChild(
      makeEmpty("No files yet. Files you send or receive will appear here.")
    );
    return;
  }

  const recentFiles = [...files]
    .sort((a, b) =>
      new Date(b.created_at || 0).getTime() -
      new Date(a.created_at || 0).getTime()
    )
    .slice(0, 5);

  for (const file of recentFiles) {
    const item = document.createElement("div");
    item.className = "recent-file";

    const name = document.createElement("p");
    name.className = "recent-file-name";
    name.textContent = file.filename || "Unnamed file";

    const size = document.createElement("p");
    size.className = "recent-file-size";
const bytes = Number(file.size) || 0;
size.textContent = bytes < 1024 * 1024
  ? `${(bytes / 1024).toFixed(1)} KB`
  : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  
    item.append(name, size);
    container.appendChild(item);
  }
}


function renderPendingRequests() {
  const container = $("pending-requests");
  if (!container) return;

  container.replaceChildren();

  if (!state.pending.length) {
    container.appendChild(makeEmpty("No pending requests."));
    return;
  }

  state.pending.forEach((item) => {
    const row = document.createElement("div");
    row.className = "device-card";

    const details = document.createElement("div");
    details.className = "file-details";

    const name = document.createElement("strong");
    name.textContent = item.name || "Unnamed device";

    const meta = document.createElement("small");
    meta.textContent = `Request ${item.id ?? item.request_id ?? ""} · ${formatDate(item.created_at)}`;

    details.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "device-actions";

    actions.append(
      makeButton("Approve", "button primary", async () => {
        try {
          const id = item.id ?? item.request_id;
          await request(
            `/api/admin/pair-requests/${encodeURIComponent(id)}/approve`,
            {
              method: "POST",
            },
          );
          showToast("Device approved.");
          await refreshDashboard();
          await refreshDevices();
        } catch (error) {
          showError(error);
        }
      }),
      makeButton("Reject", "button secondary", async () => {
        try {
          const id = item.id ?? item.request_id;
          await request(
            `/api/admin/pair-requests/${encodeURIComponent(id)}/reject`,
            {
              method: "POST",
            },
          );
          showToast("Pairing request rejected.");
          await refreshDashboard();
          await refreshDevices();
        } catch (error) {
          showError(error);
        }
      }),
    );

    row.append(details, actions);
    container.appendChild(row);
  });
}

function renderDevices() {
  const container = $("paired-devices");
  if (!container) return;

  container.replaceChildren();

  if (!state.devices.length) {
    container.appendChild(makeEmpty("No paired devices yet."));
    return;
  }

  state.devices.forEach((device) => {
    const card = document.createElement("div");
    card.className = "device-card";

    const title = document.createElement("strong");
    title.textContent = device.name || `Device ${device.id}`;

    const meta = document.createElement("small");
    meta.textContent = `Last seen: ${formatDate(device.last_seen)}`;

    const details = document.createElement("div");
    details.className = "file-details";
    details.append(title, meta);

    const permissions = document.createElement("div");
    permissions.className = "permission-controls";

    const uploadLabel = document.createElement("label");
    const uploadCheck = document.createElement("input");
    uploadCheck.type = "checkbox";
    uploadCheck.checked = Boolean(device.can_upload);
    uploadLabel.append(
      uploadCheck,
      document.createTextNode(" Can upload to PC"),
    );

    const downloadLabel = document.createElement("label");
    const downloadCheck = document.createElement("input");
    downloadCheck.type = "checkbox";
    downloadCheck.checked = Boolean(device.can_download);
    downloadLabel.append(
      downloadCheck,
      document.createTextNode(" Can download"),
    );

    const savePermissions = async () => {
      try {
        await request(
          `/api/admin/devices/${encodeURIComponent(device.id)}/permissions`,
          {
            method: "PATCH",
            body: JSON.stringify({
              can_upload: uploadCheck.checked,
              can_download: downloadCheck.checked,
            }),
          },
        );

        showToast(`Permissions updated for ${device.name || "device"}.`);
      } catch (error) {
        uploadCheck.checked = Boolean(device.can_upload);
        downloadCheck.checked = Boolean(device.can_download);
        showError(error);
      }
    };

    uploadCheck.addEventListener("change", savePermissions);
    downloadCheck.addEventListener("change", savePermissions);

    permissions.append(uploadLabel, downloadLabel);

    const revoke = makeButton("Revoke access", "button danger", async () => {
      if (!confirm(`Revoke access for ${device.name || "this device"}?`))
        return;

      try {
        await request(`/api/admin/devices/${encodeURIComponent(device.id)}`, {
          method: "DELETE",
        });

        showToast("Device access revoked.");
        await refreshDashboard();
        await refreshDevices();
      } catch (error) {
        showError(error);
      }
    });

    card.append(details, permissions, revoke);
    container.appendChild(card);
  });
}

function createFileRow(file, adminMode = false) {
  const row = document.createElement("div");
  row.className = "file-row";

  const icon = document.createElement("span");
  icon.className = "file-type-icon";
  icon.textContent = fileSymbol(file.filename || file.name);

  const details = document.createElement("span");
  details.className = "file-details";

  const name = document.createElement("strong");
  name.textContent = file.filename || file.name || "Unnamed file";

  const meta = document.createElement("small");
  meta.textContent = `${humanSize(file.size)} · ${formatDate(file.created_at)}`;

  details.append(name, meta);

  const actions = document.createElement("div");
  actions.className = "file-actions";

  actions.appendChild(
    makeButton("Download", "button secondary", () => downloadFile(file)),
  );

  if (adminMode) {
    const shareSelect = document.createElement("select");
    shareSelect.className = "share-select";

    const first = document.createElement("option");
    first.value = "";
    first.textContent = "Share with…";
    shareSelect.appendChild(first);

    state.devices.forEach((device) => {
      const option = document.createElement("option");
      option.value = String(device.id);
      option.textContent = device.name || `Device ${device.id}`;
      shareSelect.appendChild(option);
    });

    shareSelect.addEventListener("change", async () => {
      if (!shareSelect.value) return;

      try {
        await request(`/api/admin/files/${encodeURIComponent(file.id)}/share`, {
          method: "POST",
          body: JSON.stringify({ device_id: Number(shareSelect.value) }),
        });
        showToast("File shared with the selected device.");
        await refreshFiles();
      } catch (error) {
        showError(error);
      }
    });

    actions.appendChild(shareSelect);

    if (file.target_device_id != null) {
      actions.appendChild(
        makeButton("Unshare", "button secondary", async () => {
          try {
            await request(
              `/api/admin/files/${encodeURIComponent(file.id)}/share`,
              {
                method: "DELETE",
              },
            );
            showToast("File sharing removed.");
            await refreshFiles();
          } catch (error) {
            showError(error);
          }
        }),
      );
    }

    actions.appendChild(
      makeButton("Delete", "button danger", async () => {
        if (!confirm(`Delete ${file.filename || file.name || "this file"}?`))
          return;

        try {
          await request(`/api/admin/files/${encodeURIComponent(file.id)}`, {
            method: "DELETE",
          });
          showToast("File deleted.");
          await refreshDashboard();
          await refreshFiles();
        } catch (error) {
          showError(error);
        }
      }),
    );
  }

  row.append(icon, details, actions);
  return row;
}

async function downloadFile(file) {
  try {
    const response = await fetch(
      `/api/download/${encodeURIComponent(file.id)}`,
      {
        headers: authHeaders(),
      },
    );

    if (!response.ok) {
      throw new Error((await response.text()) || "Download failed.");
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = file.filename || file.name || "download";
    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 30000);
    showToast("Download started.");
  } catch (error) {
    showError(error);
  }
}

async function refreshFiles() {
  const result = await request("/api/files");
  state.files = Array.isArray(result) ? result : result.files || [];

  const adminMode = Boolean(state.adminToken);

  ["receive-files", "history-files", "recent-files"].forEach((id) => {
    const container = $(id);
    if (!container) return;

    container.replaceChildren();

    const files = id === "recent-files" ? state.files.slice(0, 4) : state.files;

    if (!files.length) {
      container.appendChild(
        makeEmpty(
          id === "history-files"
            ? "No file records available yet."
            : "No files available yet.",
        ),
      );
      return;
    }

    files.forEach((file) => {
      container.appendChild(createFileRow(file, adminMode));
    });
  });

  updateStats();
}

$("refresh-files")?.addEventListener("click", () => {
  refreshFiles()
    .then(() => showToast("Files refreshed."))
    .catch(showError);
});

$("refresh-history")?.addEventListener("click", () => {
  refreshFiles()
    .then(() => showToast("History refreshed."))
    .catch(showError);
});

$("refresh-pending")?.addEventListener("click", () => {
  refreshDevices()
    .then(() => showToast("Device list refreshed."))
    .catch(showError);
});

async function uploadOneFile(file, targetDeviceId) {
  const start = await request("/api/upload/start", {
    method: "POST",
    body: JSON.stringify({
      filename: file.name,
      size: file.size,
      ...(state.adminToken && targetDeviceId
        ? { target_device_id: Number(targetDeviceId) }
        : {}),
    }),
  });

  const uploadId = start.upload_id;
  if (!uploadId)
    throw new Error("The server did not create an upload session.");

  const chunkSize = Number(start.chunk_size) || state.chunkSize;
  const expectedChunks = Number.isInteger(start.chunks_expected)
    ? start.chunks_expected
    : Math.ceil(file.size / chunkSize);

  let transferred = 0;
  const started = performance.now();

  for (let index = 0; index < expectedChunks; index++) {
    const offset = index * chunkSize;
    const chunk = file.slice(offset, Math.min(file.size, offset + chunkSize));

    await request(
      `/api/upload/chunk/${encodeURIComponent(uploadId)}/${index}`,
      {
        method: "PUT",
        body: chunk,
      },
    );

    transferred += chunk.size;

    const elapsed = Math.max((performance.now() - started) / 1000, 0.001);
    const speed = transferred / elapsed / 1024 / 1024;
    const percent = file.size ? (transferred / file.size) * 100 : 100;

    const bar = $("send-progress-bar");
    if (bar) bar.style.width = `${percent}%`;

    const track = $("send-progress-track");
    if (track) track.classList.remove("hidden");

    if ($("send-status")) {
      $("send-status").textContent =
        `${file.name}: ${percent.toFixed(1)}% · ${humanSize(transferred)} · ${speed.toFixed(2)} MB/s`;
    }
  }

  await request("/api/upload/finish", {
    method: "POST",
    body: JSON.stringify({ upload_id: uploadId }),
  });
}

function renderSelectedFiles() {
  const container = $("selected-files");
  if (!container) return;

  container.replaceChildren();

  if (!state.chosenFiles.length) {
    container.appendChild(makeEmpty("No files selected."));
    if ($("start-send")) $("start-send").disabled = true;
    return;
  }

  state.chosenFiles.forEach((file, index) => {
    const row = document.createElement("div");
    row.className = "selected-file";

    const icon = document.createElement("span");
    icon.className = "file-type-icon";
    icon.textContent = fileSymbol(file.name);

    const details = document.createElement("span");
    details.className = "file-details";

    const name = document.createElement("strong");
    name.textContent = file.name;

    const size = document.createElement("small");
    size.textContent = humanSize(file.size);

    details.append(name, size);

    const remove = makeButton("×", "remove-file", () => {
      state.chosenFiles.splice(index, 1);
      renderSelectedFiles();
    });

    row.append(icon, details, remove);
    container.appendChild(row);
  });

  const isAllowed =
    state.adminToken ||
    Boolean(state.device?.can_upload ?? state.device?.permissions?.can_upload);

  if ($("start-send")) {
    $("start-send").disabled = !isAllowed || state.busy;
  }

  if ($("send-status")) {
    const total = state.chosenFiles.reduce((sum, file) => sum + file.size, 0);
    $("send-status").textContent =
      `${state.chosenFiles.length} file(s) selected · ${humanSize(total)} total`;
  }
}

$("send-files")?.addEventListener("change", (event) => {
  state.chosenFiles = Array.from(event.target.files || []);
  renderSelectedFiles();
});

const dropZone = $("drop-zone");

if (dropZone) {
  ["dragenter", "dragover"].forEach((type) => {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach((type) => {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.remove("drag-over");
    });
  });

  dropZone.addEventListener("drop", (event) => {
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;

    state.chosenFiles = files;
    renderSelectedFiles();
  });

  dropZone.addEventListener("click", (event) => {
    if (event.target.closest("button, label, input")) return;
    $("send-files")?.click();
  });
}

$("start-send")?.addEventListener("click", async () => {
  if (state.busy || !state.chosenFiles.length) return;

  const targetId = $("send-target")?.value;

  if (state.adminToken && !targetId) {
    showToast("Choose an approved device first.", true);
    return;
  }

  if (
    !state.adminToken &&
    !Boolean(state.device?.can_upload ?? state.device?.permissions?.can_upload)
  ) {
    showToast("This device is not allowed to upload files.", true);
    return;
  }

  state.busy = true;
  if ($("start-send")) $("start-send").disabled = true;
  if ($("send-files")) $("send-files").disabled = true;

  try {
    const files = [...state.chosenFiles];

    for (const file of files) {
      await uploadOneFile(file, targetId);
    }

    if ($("send-progress-bar")) $("send-progress-bar").style.width = "100%";
    if ($("send-status"))
      $("send-status").textContent = "All transfers completed successfully.";

    state.chosenFiles = [];
    if ($("send-files")) {
      $("send-files").value = "";
      $("send-files").disabled = false;
    }

    renderSelectedFiles();
    await refreshDashboard();
    await refreshFiles();
    showToast("Transfer completed successfully.");
  } catch (error) {
    if ($("send-status"))
      $("send-status").textContent = `Transfer failed: ${error.message}`;
    showToast(`Transfer failed: ${error.message}`, true);
  } finally {
    state.busy = false;
    if ($("send-files")) $("send-files").disabled = false;
    renderSelectedFiles();
  }
});

async function refreshDashboardSafe() {
  try {
    await refreshDashboard();
  } catch (error) {
    console.warn(error);
  }
}

async function refreshDashboardAndDevices() {
  await refreshDashboardSafe();
  if (state.adminToken) {
    try {
      await refreshDevices();
    } catch (error) {
      console.warn(error);
    }
  }
}

renderSelectedFiles();
showPage("home");

initialize().catch((error) => {
  console.error(error);
  setConnection("Connection error", "Check that the PC server is running");
  setNotice(
    `Could not initialize RiftTransfer: ${error.message}. Open the PC dashboard at http://127.0.0.1:8765.`,
    true,
  );
  showToast(error.message, true);
});
