const objects = window.FIRMWARE_SOURCE_OBJECTS;
const tree = window.FIRMWARE_SOURCE_TREE;

const fileTree = document.querySelector("#fileTree");
let currentPath = "protocol/CHIP-20.md";

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
  if (["SOLIDITY", "TYPESCRIPT", "JAVASCRIPT", "TEST"].includes(language)) {
    safe = safe.replace(/\b(pragma|contract|interface|struct|event|error|function|public|external|view|pure|returns|mapping|import|from|export|async|await|const|return|throw|new|try|catch|if)\b/g, '<span class="keyword">$1</span>');
    safe = safe.replace(/\b(address|bytes32|bytes4|uint256|uint128|uint64|uint48|uint32|uint16|bool|string|Promise|void)\b/g, '<span class="type">$1</span>');
  }
  safe = safe.replace(/\b([0-9]+(?:\.[0-9]+)?)\b/g, '<span class="number">$1</span>');
  return safe || " ";
}

function openObject(path) {
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
  document.querySelector("#codeScroll").scrollTop = 0;
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
    openObject(button.dataset.open);
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
const loadCycle = [18, 26, 39, 78, 61, 34];
const stateCycle = [
  "VERIFYING INPUT",
  "IDENTITY PINNED",
  "AUTHORITY PASS",
  "RUNNING LOCAL",
  "DIGEST WRITTEN",
  "ROUTE SETTLED"
];
const moduleDetails = {
  "schemas/chip.manifest.json": {
    index: "U01", description: "Defines the capability package before installation. The runtime rejects unknown fields and verifies the artifact digest before granting any authority.",
    input: "Package metadata", output: "Canonical manifest", boundary: "Schema + digest", bus: ["bus-a", "bus-a-thin"]
  },
  "contracts/ChipRegistry.sol": {
    index: "U03", description: "Pins publisher identity, semantic version and artifact hash to an immutable registry record used by every later execution.",
    input: "Publisher + artifact", output: "Version record", boundary: "Identity only", bus: ["bus-c", "bus-c-thin"]
  },
  "contracts/PermissionKernel.sol": {
    index: "U02", description: "Intersects requested authority with Machine policy. Contract targets, selectors, value and rolling budgets must all pass before dispatch.",
    input: "Call intent", output: "Permit / reject", boundary: "Allowlist + budget", bus: ["bus-b", "bus-b-thin"]
  },
  "runtime/executor.ts": {
    index: "U00", description: "Verifies the Machine signature and exact artifact, loads it into the approved local runtime, meters execution and returns a deterministic output digest without publishing private inputs.",
    input: "Approved invocation", output: "Result digest", boundary: "Local sandbox", bus: ["bus-a", "bus-b", "bus-c", "bus-d", "bus-e"]
  },
  "contracts/ExecutionReceiptRegistry.sol": {
    index: "U04", description: "Accepts each execution record only from the Machine or a reporter the Machine explicitly approved, then prevents that invocation from being recorded twice.",
    input: "Execution result", output: "Authorized receipt", boundary: "Machine reporter", bus: ["bus-d", "bus-d-thin"]
  },
  "contracts/RevenueRouter.sol": {
    index: "U05", description: "Checks receipt asset, amount and route digest, prevents duplicate settlement and routes the exact cost without retaining custody.",
    input: "Receipt + route", output: "Settlement", boundary: "One settlement", bus: ["bus-e", "bus-e-thin"]
  },
  "scheduler": { index: "U10", description: "Rejects malformed signatures, altered fields, wrong artifacts, expired invocations and installation mismatches before any state is reserved.", input: "Invocation", output: "Accepted request", boundary: "Deadline + identity", bus: ["bus-a", "bus-c"] },
  "artifact-loader": { index: "U11", description: "Hashes the supplied artifact bytes and rejects them unless both the manifest and installed revision contain the same digest.", input: "Artifact bytes", output: "Verified artifact", boundary: "SHA256 digest", bus: ["bus-a", "bus-a-thin"] },
  "verifier": { index: "U12", description: "Checks Chip identity, semantic version, installation expiry, revocation state, manifest digest and artifact digest before execution.", input: "Installed package", output: "Verified package", boundary: "Pinned identity", bus: ["bus-d", "bus-d-thin"] },
  "nonce-guard": { index: "U20", description: "Atomically persists a Machine nonce and budget reservation before execution, rejects replay and recovers expired reservations after interruption.", input: "Machine + nonce", output: "Claim result", boundary: "Replay protection", bus: ["bus-b", "bus-b-thin"] },
  "selector-filter": { index: "U21", description: "Matches every contract call against the exact destination and function selectors approved by Machine policy.", input: "Target + selector", output: "Allowed call", boundary: "Call allowlist", bus: ["bus-b", "bus-b-thin"] },
  "budget-meter": { index: "U22", description: "Derives spend from native value or a fixed calldata word, then enforces per-call and rolling-window limits.", input: "Value + history", output: "Budget headroom", boundary: "Spend ceiling", bus: ["bus-b", "bus-e"] },
  "version-pin": { index: "U30", description: "Resolves a Chip identifier to one exact version and artifact hash; upgrades require a new explicit pin.", input: "Chip ID + version", output: "Pinned artifact", boundary: "No silent upgrade", bus: ["bus-c", "bus-c-thin"] },
  "digest-engine": { index: "U40", description: "Canonicalizes JSON and computes SHA256 input and output digests without placing the original task data onchain.", input: "Private payload", output: "SHA256 digest", boundary: "Digests only", bus: ["bus-d", "bus-d-thin"] },
  "receipt-signer": { index: "U41", description: "Allows the Machine or its approved reporter to bind the Chip revision, artifact, cost and result digest to one invocation.", input: "Receipt fields", output: "Authorized record", boundary: "Machine approval", bus: ["bus-d", "bus-e"] },
  "price-meter": { index: "U50", description: "Compares the measured sandbox cost with the maximum amount signed in the invocation and releases the reservation on failure.", input: "Metered cost", output: "Accepted cost", boundary: "Maximum cost", bus: ["bus-e", "bus-e-thin"] },
  "revenue-router": { index: "U51", description: "Checks the committed receipt asset and amount, prevents duplicate settlement and splits payment without retaining custody.", input: "Receipt + split", output: "Payment routes", boundary: "One settlement", bus: ["bus-e", "bus-e-thin"] },
  "watchdog": { index: "U60", description: "Fails closed on invalid packages, expired requests, duplicate nonces, budget errors and sandbox failures, then releases reserved state.", input: "Runtime failure", output: "Rollback", boundary: "Fail closed", bus: ["bus-a", "bus-b", "bus-c", "bus-d", "bus-e"] }
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
  const detail = moduleDetails[chip.dataset.module || path];
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
  const activeDetail = activeChip ? moduleDetails[activeChip.dataset.open] : null;
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
  if (runtimeLoad) runtimeLoad.textContent = loadCycle[runtimeStep] + "%";
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
