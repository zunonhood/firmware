const objects = window.FIRMWARE_SOURCE_OBJECTS;
const tree = window.FIRMWARE_SOURCE_TREE;

const fileTree = document.querySelector("#fileTree");
let currentPath = "programs/firmware/src/lib.rs";

function fileKind(path) {
  const extension = path.split(".").pop().toUpperCase();
  return extension === "MD" ? "DOC" : extension;
}

function createRow(label, path, type, depth) {
  const row = document.createElement("button");
  row.className = "tree-row";
  row.dataset.depth = depth;
  row.dataset.type = type;
  row.dataset.path = path || "";
  row.innerHTML = '<span class="chev">' + (type === "folder" ? ">" : "") +
    '</span><span class="file-icon">' + (type === "folder" ? "[]" : "::") +
    '</span><span class="file-name">' + label + '</span><span class="file-kind">' +
    (type === "folder" ? "DIR" : fileKind(path)) + '</span>';
  return row;
}

tree.forEach((entry) => {
  if (entry.type === "folder") {
    const folder = createRow(entry.name, entry.name, "folder", 0);
    folder.classList.add("open");
    fileTree.appendChild(folder);
    entry.children.forEach((path) => {
      const file = createRow(path.split("/").pop(), path, "file", 1);
      file.dataset.parent = entry.name;
      file.onclick = () => openObject(path);
      fileTree.appendChild(file);
    });
    folder.onclick = () => {
      folder.classList.toggle("open");
      const open = folder.classList.contains("open");
      fileTree.querySelectorAll('[data-parent="' + entry.name + '"]')
        .forEach((row) => row.hidden = !open);
    };
  } else {
    const file = createRow(entry.name, entry.name, "file", 0);
    file.onclick = () => openObject(entry.name);
    fileTree.appendChild(file);
  }
});

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function highlight(line, language) {
  const trimmed = line.trim();
  let safe = escapeHtml(line);
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") ||
      trimmed.startsWith("* ") || trimmed.startsWith("Copyright:")) {
    return '<span class="comment">' + safe + '</span>';
  }
  if (trimmed.startsWith("#")) {
    return '<span class="heading">' + safe + '</span>';
  }
  if (language.includes("JSON")) {
    safe = safe.replace(/(&quot;[^&]*?&quot;)(?=\s*:)/g, '<span class="type">$1</span>');
    safe = safe.replace(/:\s*(&quot;.*?&quot;)/g, ': <span class="string">$1</span>');
  }
  if (["RUST", "TYPESCRIPT", "JAVASCRIPT", "TEST"].includes(language)) {
    safe = safe.replace(/\b(pub|fn|struct|enum|impl|use|mod|let|mut|const|return|if|else|match|Self|true|false|import|from|export|async|await|throw|new|try|catch)\b/g, '<span class="keyword">$1</span>');
    safe = safe.replace(/\b(Pubkey|Account|Signer|Context|Result|u128|u64|u32|u16|i64|bool|String|Promise|void)\b/g, '<span class="type">$1</span>');
  }
  safe = safe.replace(/\b([0-9]+(?:\.[0-9]+)?)\b/g, '<span class="number">$1</span>');
  return safe || " ";
}

function openObject(path, symbol) {
  const object = objects[path];
  if (!object) return;
  currentPath = path;
  document.querySelector("#currentPath").textContent = path.replace("/", " / ");
  document.querySelector("#languageLabel").textContent = object.language;
  document.querySelector("#objectState").textContent = object.state;
  document.querySelector("#sourceSummary").textContent = object.description;
  const lines = object.content.split("\n");
  document.querySelector("#lineCount").textContent = lines.length + " LINES";
  document.querySelector("#codeView").innerHTML = lines.map((line, index) =>
    '<span class="code-line"><span class="num">' +
    String(index + 1).padStart(3, "0") +
    '</span>' + highlight(line, object.language) + '</span>'
  ).join("");
  document.querySelectorAll(".tree-row").forEach((row) =>
    row.classList.toggle("active", row.dataset.path === path)
  );
  document.querySelector("#loadState").textContent = "OBJECT VERIFIED / LOCAL";
  const matchLine = symbol ? lines.findIndex((line) => line.includes(symbol)) : -1;
  const codeScroll = document.querySelector("#codeScroll");
  const codeLines = codeScroll.querySelectorAll(".code-line");
  codeLines.forEach((line, index) => line.classList.toggle("symbol-focus", index === matchLine));
  codeScroll.scrollTop = matchLine >= 0 ? codeLines[matchLine].offsetTop - codeScroll.offsetTop - 90 : 0;
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 1800);
}

document.querySelectorAll("[data-open]").forEach((button) => {
  button.onclick = () => {
    openObject(button.dataset.open, button.dataset.symbol);
    if (button.classList.contains("runtime-chip")) {
      document.querySelector("#specification").scrollIntoView({ behavior: "smooth" });
    }
  };
});

const runtimeChips = [...document.querySelectorAll("[data-runtime-step]")];
const inspectableChips = [...document.querySelectorAll(".runtime-chip[data-open]")];
const runtimeFlow = [...document.querySelectorAll("[data-flow-step]")];
const runtimeLoad = document.querySelector("#runtimeLoad");
const runtimeStage = document.querySelector("#runtimeStage");
const runtimeInvocation = document.querySelector("#runtimeInvocation");
const coreState = document.querySelector("#coreState");
const flowMap = [0, 0, 1, 2, 3, 3];
const loadCycle = ["PINNED", "REVISION", "LIMITED", "RECORDED", "UNIQUE", "SETTLED"];
const stateCycle = ["INSTALL ARGS", "CHIP PDA", "POLICY CHECK", "RECORD RECEIPT", "RECEIPT PDA", "SPL SETTLEMENT"];
const moduleDetails = {
  manifest: { index: "U01", description: "InstallArgs is the exact owner supplied policy: revision, expiry, mint, budget and payment route.", input: "Owner policy", output: "InstallArgs", boundary: "Explicit fields", bus: ["bus-a", "bus-a-thin"] },
  registry: { index: "U03", description: "create_chip creates a publisher owned PDA. publish_revision advances the revision and pins artifact and manifest digests.", input: "Publisher + Chip ID", output: "Chip PDA", boundary: "Sequential revision", bus: ["bus-c", "bus-c-thin"] },
  policy: { index: "U02", description: "install_chip checks a live revision, expiry, budget, mint and recipient split before the Machine accepts it.", input: "Revision + limits", output: "Installation PDA", boundary: "Owner signature", bus: ["bus-b", "bus-b-thin"] },
  core: { index: "U00", description: "record_receipt enforces operator authority, active installation, expiry and both spending ceilings before recording a result.", input: "Operator report", output: "Receipt PDA", boundary: "Cost + time", bus: ["bus-a", "bus-b", "bus-c", "bus-d", "bus-e"] },
  receipt: { index: "U04", description: "Receipt stores invocation and input/output digests, cost, reporter, route digest and one time settlement state.", input: "Result digests", output: "Receipt account", boundary: "Unique invocation", bus: ["bus-d", "bus-d-thin"] },
  settlement: { index: "U05", description: "settle verifies token accounts and committed route, then splits one receipt cost through SPL Token transfers.", input: "Receipt + vault", output: "Three transfers", boundary: "Settle once", bus: ["bus-e", "bus-e-thin"] },
  scheduler: { index: "U10", description: "The onchain receipt gate rejects expired, revoked or over budget installations before creating a receipt.", input: "Invocation ID", output: "Accepted report", boundary: "Expiry + status", bus: ["bus-a", "bus-c"] },
  "artifact-loader": { index: "U11", description: "A published revision pins the artifact digest. The program records the digest but does not download or execute private bytes.", input: "Artifact digest", output: "Revision PDA", boundary: "Immutable digest", bus: ["bus-a", "bus-a-thin"] },
  verifier: { index: "U12", description: "An installation requires a revision belonging to the selected Chip and rejects revoked revisions.", input: "Chip + revision", output: "Pinned install", boundary: "Account relation", bus: ["bus-d", "bus-d-thin"] },
  "nonce-guard": { index: "U20", description: "The receipt PDA includes installation and invocation ID. Reusing that pair cannot create a second account.", input: "Invocation ID", output: "Unique PDA", boundary: "Replay rejection", bus: ["bus-b", "bus-b-thin"] },
  "account-boundary": { index: "U21", description: "Anchor account constraints require the Machine PDA, selected mint and exact owner controlled recipient token accounts.", input: "Accounts", output: "Validated accounts", boundary: "PDA + mint + owner", bus: ["bus-b", "bus-b-thin"] },
  "budget-meter": { index: "U22", description: "The program adds reported cost to a rolling window and rejects totals over the installation limit.", input: "Cost + window", output: "New spend", boundary: "Rolling ceiling", bus: ["bus-b", "bus-e"] },
  "version-pin": { index: "U30", description: "A new revision has a new PDA and cannot overwrite the artifact digest of a previous revision.", input: "Revision number", output: "Pinned digests", boundary: "No silent upgrade", bus: ["bus-c", "bus-c-thin"] },
  "digest-engine": { index: "U40", description: "route_digest binds token mint, all three recipients and their basis point shares to the installation.", input: "Payment route", output: "Route digest", boundary: "SHA256", bus: ["bus-d", "bus-d-thin"] },
  "receipt-reporter": { index: "U41", description: "Only the Machine's current operator can record a receipt, and the reporter key is stored with it.", input: "Operator signature", output: "Attributable receipt", boundary: "Signer check", bus: ["bus-d", "bus-e"] },
  "price-meter": { index: "U50", description: "A reported cost must be positive and cannot exceed the owner's per invocation maximum.", input: "Reported cost", output: "Accepted cost", boundary: "Max cost", bus: ["bus-e", "bus-e-thin"] },
  "revenue-router": { index: "U51", description: "The transfer helper uses Machine PDA signer seeds and SPL Token transfer_checked for each recipient.", input: "Vault + split", output: "Token transfers", boundary: "Token program", bus: ["bus-e", "bus-e-thin"] },
  watchdog: { index: "U60", description: "Explicit error codes cover revoked revisions, expired installations, budget overflow and duplicate settlement.", input: "Invalid state", output: "Transaction rejected", boundary: "Fail closed", bus: ["bus-a", "bus-b", "bus-c", "bus-d", "bus-e"] }
};
const inspector = document.querySelector("#moduleInspector");
const inspectorFields = {
  index: document.querySelector("#inspectorIndex"),
  path: document.querySelector("#inspectorPath"),
  description: document.querySelector("#inspectorDescription"),
  input: document.querySelector("#inspectorInput"),
  output: document.querySelector("#inspectorOutput"),
  boundary: document.querySelector("#inspectorBoundary"),
  state: document.querySelector("#inspectorState")
};
let inspectedPath = null;

function inspectModule(chip) {
  const path = chip.dataset.open;
  const detail = moduleDetails[chip.dataset.module];
  if (!detail) return;
  inspectedPath = path;
  if (inspector) {
    inspector.classList.add("active");
    inspectorFields.index.textContent = detail.index;
    inspectorFields.path.textContent = path;
    inspectorFields.description.textContent = detail.description;
    inspectorFields.input.textContent = detail.input;
    inspectorFields.output.textContent = detail.output;
    inspectorFields.boundary.textContent = detail.boundary;
    inspectorFields.state.textContent = "SOURCE LINK ACTIVE";
  }
  inspectableChips.forEach((item) => item.classList.toggle("inspected", item === chip));
  document.querySelectorAll(".copper").forEach((trace) =>
    trace.classList.toggle("inspected-bus", detail.bus.includes([...trace.classList].find((name) => name.startsWith("bus-"))))
  );
  document.querySelectorAll(".tree-row").forEach((row) =>
    row.classList.toggle("mapped", row.dataset.path === path)
  );
}

function clearModuleInspection() {
  inspectedPath = null;
  if (inspector) inspector.classList.remove("active");
  inspectableChips.forEach((chip) => chip.classList.remove("inspected"));
  document.querySelectorAll(".copper.inspected-bus").forEach((trace) => trace.classList.remove("inspected-bus"));
  document.querySelectorAll(".tree-row.mapped").forEach((row) => row.classList.remove("mapped"));
  if (inspectorFields.state) inspectorFields.state.textContent = "HOVER A CHIP TO INSPECT";
}

inspectableChips.forEach((chip) => {
  chip.addEventListener("mouseenter", () => inspectModule(chip));
  chip.addEventListener("mouseleave", clearModuleInspection);
  chip.addEventListener("focus", () => inspectModule(chip));
  chip.addEventListener("blur", clearModuleInspection);
});
let runtimeStep = 0;
let invocationNumber = 0x08F2;

function renderRuntime() {
  if (inspectedPath) return;
  const activeChip = runtimeChips.find((chip) => Number(chip.dataset.runtimeStep) === runtimeStep);
  const activeDetail = activeChip ? moduleDetails[activeChip.dataset.module] : null;
  runtimeChips.forEach((chip) =>
    chip.classList.toggle("active", chip === activeChip)
  );
  document.querySelectorAll(".copper").forEach((trace) => {
    const busName = [...trace.classList].find((name) => name.startsWith("bus-"));
    trace.classList.toggle("runtime-bus", Boolean(activeDetail && activeDetail.bus.includes(busName)));
  });
  runtimeFlow.forEach((item) =>
    item.classList.toggle("active", Number(item.dataset.flowStep) === flowMap[runtimeStep])
  );
  if (runtimeLoad) runtimeLoad.textContent = loadCycle[runtimeStep];
  if (runtimeStage) runtimeStage.textContent = stateCycle[runtimeStep];
  if (coreState) coreState.textContent = stateCycle[runtimeStep];
  if (runtimeInvocation) {
    runtimeInvocation.textContent = "0x" + invocationNumber.toString(16).toUpperCase().padStart(4, "0");
  }
  runtimeStep = (runtimeStep + 1) % runtimeChips.length;
  if (runtimeStep === 0) invocationNumber += 1;
}

renderRuntime();
if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  setInterval(renderRuntime, 2200);
}

document.querySelector("#copyButton").onclick = async () => {
  await navigator.clipboard.writeText(objects[currentPath].content);
  showToast("OBJECT COPIED TO CLIPBOARD");
};

document.querySelector("#downloadButton").onclick = () => {
  const blob = new Blob([objects[currentPath].content], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = currentPath.split("/").pop();
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("OBJECT DOWNLOAD STARTED");
};

openObject(currentPath);
