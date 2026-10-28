const $ = id => document.getElementById(id);
let token = new URLSearchParams(location.search).get("token");
let chunkSize = 4 * 1024 * 1024;
let chosenFiles = [];
let transferHistory = [];
let toastTimer;

async function request(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed (${response.status})`);
  }
  return response;
}

function showToast(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function goToPage(name) {
  const safeName = ["home", "send", "receive", "devices", "history"].includes(name) ? name : "home";
  document.querySelectorAll(".page").forEach(page => page.classList.toggle("active-page", page.id === `page-${safeName}`));
  document.querySelectorAll("[data-page]").forEach(button => button.classList.toggle("active", button.dataset.page === safeName));
  const labels = {home:"Home", send:"Send files", receive:"Receive files", devices:"Devices", history:"Transfer history"};
  $("page-crumb").textContent = labels[safeName];
  if (safeName === "receive") refreshFiles().catch(error => showToast(error.message, true));
  if (safeName === "history") renderHistory();
  if (safeName === "home") renderHomeHistory();
  window.scrollTo({top:0, behavior:"smooth"});
}

document.querySelectorAll("[data-page]").forEach(button => button.addEventListener("click", () => goToPage(button.dataset.page)));
document.querySelectorAll("[data-go]").forEach(button => button.addEventListener("click", () => goToPage(button.dataset.go)));
document.querySelectorAll("[data-page-link]").forEach(link => link.addEventListener("click", event => { event.preventDefault(); goToPage(link.dataset.pageLink); }));

async function initialize() {
  const infoResponse = await fetch("/api/info");
  if (!infoResponse.ok) throw new Error("Couldn't reach the RiftTransfer server.");
  const info = await infoResponse.json();
  if (!token) token = info.token;
  chunkSize = info.chunk_size || chunkSize;
  const host = ["localhost", "127.0.0.1"].includes(location.hostname) ? info.ip : location.hostname;
  const address = `${host}:${info.port || 8765}`;
  $("connection").textContent = address;
  $("connection-short").textContent = "Hub online";
  $("qr").src = `/api/qr?token=${encodeURIComponent(token)}`;
  $("qr").addEventListener("error", () => { $("connection").textContent = "QR code unavailable. Check the server."; });
  await refreshFiles();
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function fileSymbol(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["png","jpg","jpeg","gif","webp","heic","svg"].includes(ext)) return "▧";
  if (["mp4","mov","mkv","avi","webm"].includes(ext)) return "▷";
  if (["doc","docx","txt","rtf","pdf"].includes(ext)) return "▤";
  if (["zip","rar","7z","gz"].includes(ext)) return "▱";
  return "▧";
}

function setProgress(percent, label, transferred, speed) {
  const safePercent = Math.max(0, Math.min(100, percent || 0));
  $("progress-fill").style.width = `${safePercent}%`;
  $("progress-percent").textContent = `${safePercent.toFixed(1)}%`;
  $("progress-label").textContent = label;
  $("progress-size").textContent = `${humanSize(transferred)} transferred`;
  $("progress-speed").textContent = speed == null ? "— MB/s" : `${speed.toFixed(2)} MB/s`;
}

async function transfer(file) {
  const form = new FormData();
  form.append("filename", file.name);
  form.append("size", file.size);
  form.append("token", token);
  const start = await request("/api/upload/start", {method:"POST", body:form});
  const session = await start.json();
  let offset = 0;
  const started = performance.now();
  while (offset < file.size) {
    const chunk = file.slice(offset, offset + chunkSize);
    const response = await request(`/api/upload/${session.upload_id}/chunk`, {
      method:"PUT",
      headers:{"X-Rift-Token":token, "X-Chunk-Offset":String(offset)},
      body:chunk
    });
    const result = await response.json();
    offset = result.received;
    const seconds = Math.max(0.001, (performance.now() - started) / 1000);
    const mbps = offset / seconds / 1024 / 1024;
    setProgress(file.size ? (offset / file.size) * 100 : 100, `Sending ${file.name}`, offset, mbps);
  }
  const finish = new FormData();
  finish.append("token", token);
  await request(`/api/upload/${session.upload_id}/finish`, {method:"POST", body:finish});
  transferHistory.unshift({name:file.name,size:file.size,status:"Completed",direction:"Sent",time:new Date()});
  renderHistory();
}

function renderSelectedFiles() {
  const container = $("selected-files");
  container.replaceChildren();
  if (!chosenFiles.length) {
    const text = document.createElement("span");
    text.className = "muted";
    text.textContent = "No files selected";
    container.append(text);
    $("send").disabled = true;
    return;
  }
  $("send").disabled = false;
  chosenFiles.forEach((file, index) => {
    const row = document.createElement("div"); row.className = "selected-file";
    const icon = document.createElement("span"); icon.className = "file-type-icon"; icon.textContent = fileSymbol(file.name);
    const details = document.createElement("span"); details.className = "file-details";
    const name = document.createElement("strong"); name.textContent = file.name;
    const size = document.createElement("small"); size.textContent = humanSize(file.size);
    details.append(name,size);
    const remove = document.createElement("button"); remove.className = "remove-file"; remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", `Remove ${file.name}`);
    remove.addEventListener("click", () => { chosenFiles.splice(index,1); renderSelectedFiles(); });
    row.append(icon,details,remove); container.append(row);
  });
}

$("files").addEventListener("change", event => {
  chosenFiles = Array.from(event.target.files || []);
  renderSelectedFiles();
  setProgress(0,"Ready to transfer",0,null);
  $("status").textContent = chosenFiles.length ? `${chosenFiles.length} file(s) selected · ${humanSize(chosenFiles.reduce((sum,file)=>sum+file.size,0))} total` : "";
  $("status").className = "status-message";
});

const dropZone = $("drop-zone");
["dragenter","dragover"].forEach(type => dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.add("drag-over"); }));
["dragleave","drop"].forEach(type => dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.remove("drag-over"); }));
dropZone.addEventListener("drop", event => {
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length) { chosenFiles = files; renderSelectedFiles(); $("status").textContent = `${files.length} file(s) selected`; }
});

$("send").addEventListener("click", async () => {
  if (!chosenFiles.length) return;
  const files = [...chosenFiles];
  $("send").disabled = true;
  $("files").disabled = true;
  $("status").className = "status-message";
  try {
    let completedBytes = 0;
    const totalBytes = files.reduce((sum,file)=>sum+file.size,0);
    for (const file of files) {
      await transfer(file);
      completedBytes += file.size;
      if (totalBytes > 0 && completedBytes < totalBytes) setProgress((completedBytes/totalBytes)*100, `Completed ${file.name}`, completedBytes, null);
    }
    setProgress(100,"All transfers completed",totalBytes, null);
    $("status").textContent = "All transfers completed successfully.";
    $("status").className = "status-message success";
    chosenFiles = [];
    $("files").value = "";
    renderSelectedFiles();
    await refreshFiles();
    renderHistory();
    showToast("Transfer completed successfully.");
  } catch (error) {
    $("status").textContent = `Transfer failed: ${error.message}`;
    $("status").className = "status-message error";
    transferHistory.unshift({name:files[0]?.name || "Transfer",size:0,status:"Failed",direction:"Sent",time:new Date()});
    renderHistory();
    showToast("Transfer failed. Check the status message.", true);
  } finally {
    $("send").disabled = chosenFiles.length === 0;
    $("files").disabled = false;
  }
});

async function refreshFiles() {
  const response = await fetch(`/api/files?token=${encodeURIComponent(token || "")}`);
  if (!response.ok) throw new Error("Couldn't load the received files.");
  const data = await response.json();
  const container = $("received");
  container.replaceChildren();
  $("home-file-count").textContent = String(data.files.length);
  if (!data.files.length) {
    const empty = document.createElement("div"); empty.className = "empty-state";
    const icon = document.createElement("span"); icon.className = "empty-icon"; icon.textContent = "▤";
    const title = document.createElement("strong"); title.textContent = "No files here yet";
    const desc = document.createElement("p"); desc.textContent = "Send a file from another device and it will appear here.";
    empty.append(icon,title,desc); container.append(empty); return;
  }
  data.files.forEach(file => {
    const row = document.createElement("div"); row.className = "file-row";
    const icon = document.createElement("span"); icon.className = "file-type-icon"; icon.textContent = fileSymbol(file.name);
    const details = document.createElement("span"); details.className = "file-details";
    const name = document.createElement("strong"); name.textContent = file.name;
    const meta = document.createElement("small"); meta.textContent = humanSize(file.size);
    details.append(name,meta);
    const link = document.createElement("a"); link.className = "download-link"; link.textContent = "Download ↓";
    link.href = `/api/download/${encodeURIComponent(file.name)}?token=${encodeURIComponent(token)}`; link.download = file.name;
    row.append(icon,details,link); container.append(row);
  });
}

function makeHistoryRow(item) {
  const row = document.createElement("div"); row.className = "history-row";
  const icon = document.createElement("span"); icon.className = "file-type-icon"; icon.textContent = item.status === "Failed" ? "!" : "↗";
  const details = document.createElement("span"); details.className = "file-details";
  const name = document.createElement("strong"); name.textContent = item.name;
  const date = item.time instanceof Date ? item.time : new Date(item.time);
  const meta = document.createElement("small"); meta.textContent = `${item.direction} · ${humanSize(item.size)} · ${date.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}`;
  details.append(name,meta);
  const status = document.createElement("span"); status.className = `history-status ${item.status === "Failed" ? "failed" : "done"}`; status.textContent = item.status;
  row.append(icon,details,status); return row;
}

function renderHistory() {
  const container = $("history-list"); container.replaceChildren();
  if (!transferHistory.length) {
    const empty = document.createElement("div"); empty.className = "empty-state";
    const icon = document.createElement("span"); icon.className = "empty-icon"; icon.textContent = "◷";
    const title = document.createElement("strong"); title.textContent = "No transfers recorded yet";
    const desc = document.createElement("p"); desc.textContent = "Completed and failed transfers will appear here while this page remains open.";
    empty.append(icon,title,desc); container.append(empty); return;
  }
  transferHistory.forEach(item => container.append(makeHistoryRow(item)));
}
function renderHomeHistory() {
  const container = $("home-history"); container.replaceChildren();
  if (!transferHistory.length) {
    const empty = document.createElement("div"); empty.className = "empty-state compact-empty";
    const icon = document.createElement("span"); icon.className = "empty-icon"; icon.textContent = "◷";
    const copy = document.createElement("div"); const title = document.createElement("strong"); title.textContent = "No transfers in this session yet"; const desc = document.createElement("p"); desc.textContent = "Your latest activity will appear here."; copy.append(title,desc); empty.append(icon,copy); container.append(empty); return;
  }
  transferHistory.slice(0,3).forEach(item => container.append(makeHistoryRow(item)));
}

$("refresh").addEventListener("click", () => refreshFiles().then(() => showToast("File list refreshed.")).catch(error => showToast(error.message,true)));
$("pair-button").addEventListener("click", () => showToast("Scan the QR code with your phone camera. Individual device approvals are not enabled in this prototype."));
$("clear-history").addEventListener("click", () => { transferHistory = []; renderHistory(); renderHomeHistory(); showToast("Session history cleared."); });

// Additional row styling for status chips is kept here so the visual stays cohesive.
const extraStyles = document.createElement("style");
extraStyles.textContent = ".history-panel #history-list,.recent-panel{display:grid;gap:8px}.history-status{font-size:10px;border-radius:7px;padding:6px 8px;white-space:nowrap}.history-status.done{background:#142b25;color:#82e5b9}.history-status.failed{background:#351d25;color:#ff9eaa}.history-row{margin-bottom:8px}.history-row:last-child{margin-bottom:0}";
document.head.append(extraStyles);

initialize().catch(error => {
  $("connection").textContent = error.message;
  $("connection-short").textContent = "Offline";
  const status = document.querySelector(".status-pill");
  if (status) { status.style.borderColor = "#63353c"; status.style.color = "#ffaaaa"; }
  showToast(error.message, true);
});
