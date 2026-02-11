"use strict";

const installForm = document.getElementById("install-form");
const specifierInput = document.getElementById("specifier-input");
const installBtn = document.getElementById("install-btn");
const installStatus = document.getElementById("install-status");
const packagesList = document.getElementById("packages-list");
const noPackages = document.getElementById("no-packages");

// --- Install ---

installForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const specifier = specifierInput.value.trim();
  if (!specifier) return;

  installBtn.disabled = true;
  showStatus("Installing...", "loading");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "marketplace:install",
      specifier,
    });

    if (response.success) {
      let msg = `Installed ${response.key}`;
      if (response.warnings && response.warnings.length > 0) {
        msg += `\nWarnings:\n${response.warnings.join("\n")}`;
      }
      showStatus(msg, "success");
      specifierInput.value = "";
      await loadPackages();
    } else {
      showStatus(response.error, "error");
    }
  } catch (err) {
    showStatus(err.message, "error");
  } finally {
    installBtn.disabled = false;
  }
});

// --- Load from folder ---

const loadFolderBtn = document.getElementById("load-folder-btn");
const folderInput = document.getElementById("folder-input");

loadFolderBtn.addEventListener("click", () => folderInput.click());

folderInput.addEventListener("change", async () => {
  const files = Array.from(folderInput.files);
  if (files.length === 0) return;

  // Fast fail: folder must contain webmcp-bridge.json at the root level
  // webkitRelativePath is "foldername/webmcp-bridge.json" — exactly one slash for root-level files
  const manifestFile = files.find(
    (f) => f.name === "webmcp-bridge.json" && f.webkitRelativePath.split("/").length === 2,
  );
  if (!manifestFile) {
    const folderName = files[0]?.webkitRelativePath.split("/")[0] || "selected folder";
    showStatus(
      `Not a WebMCP plugin: "${folderName}" has no webmcp-bridge.json at its root`,
      "error",
    );
    folderInput.value = "";
    return;
  }

  showStatus("Loading from folder...", "loading");

  try {
    const manifestText = await manifestFile.text();
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      showStatus("webmcp-bridge.json is not valid JSON", "error");
      return;
    }

    // Validate manifest structure before doing any more work
    if (!manifest.name) {
      showStatus('Manifest missing required "name" field', "error");
      return;
    }
    if (!manifest.version) {
      showStatus('Manifest missing required "version" field', "error");
      return;
    }
    if (!Array.isArray(manifest.scripts) || manifest.scripts.length === 0) {
      showStatus("Manifest must have a non-empty scripts array", "error");
      return;
    }

    // Read each script file referenced in the manifest
    const scripts = {};
    for (const script of manifest.scripts) {
      if (!script.id || !script.file) {
        showStatus(`Script entry missing "id" or "file": ${JSON.stringify(script)}`, "error");
        return;
      }
      // webkitRelativePath: "foldername/scripts/example.js"
      // script.file: "scripts/example.js"
      const match = files.find((f) => f.webkitRelativePath.endsWith("/" + script.file));
      if (!match) {
        showStatus(`Script file not found in folder: ${script.file}`, "error");
        return;
      }
      scripts[script.id] = await match.text();
    }

    const response = await chrome.runtime.sendMessage({
      type: "marketplace:install-local",
      manifest,
      scripts,
    });

    if (response.success) {
      let msg = `Loaded ${response.key}`;
      if (response.warnings && response.warnings.length > 0) {
        msg += `\nWarnings:\n${response.warnings.join("\n")}`;
      }
      showStatus(msg, "success");
      await loadPackages();
    } else {
      showStatus(response.error, "error");
    }
  } catch (err) {
    showStatus(err.message, "error");
  }

  // Reset so the same folder can be re-selected
  folderInput.value = "";
});

// --- Status display ---

function showStatus(message, type) {
  installStatus.textContent = message;
  installStatus.className = `install-status ${type}`;
  installStatus.hidden = false;

  if (type === "success") {
    setTimeout(() => {
      installStatus.hidden = true;
    }, 5000);
  }
}

// --- Package list ---

async function loadPackages() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "marketplace:list" });
    if (!response.success) return;

    renderPackages(response.packages);
  } catch {
    // Extension context may be invalidated
  }
}

function renderPackages(packages) {
  packagesList.innerHTML = "";

  if (packages.length === 0) {
    noPackages.hidden = false;
    return;
  }

  noPackages.hidden = true;

  for (const pkg of packages) {
    const card = createPackageCard(pkg);
    packagesList.appendChild(card);
  }
}

function createPackageCard(pkg) {
  const card = document.createElement("div");
  card.className = "package-card";

  const { manifest } = pkg;
  const githubUrl = `https://github.com/${pkg.id}`;

  // Header row: name + version + actions
  const header = document.createElement("div");
  header.className = "package-header";

  const nameSpan = document.createElement("span");
  const nameText = document.createElement("span");
  nameText.className = "package-name";
  nameText.textContent = manifest.name || pkg.id;
  nameSpan.appendChild(nameText);

  const versionSpan = document.createElement("span");
  versionSpan.className = "package-version";
  versionSpan.textContent = `@${pkg.ref}`;
  nameSpan.appendChild(versionSpan);

  const actions = document.createElement("div");
  actions.className = "package-actions";

  // Toggle
  const toggle = document.createElement("label");
  toggle.className = "toggle";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = pkg.enabled;
  checkbox.addEventListener("change", async () => {
    await chrome.runtime.sendMessage({
      type: "marketplace:toggle",
      key: pkg.key,
      enabled: checkbox.checked,
    });
  });
  const slider = document.createElement("span");
  slider.className = "toggle-slider";
  toggle.appendChild(checkbox);
  toggle.appendChild(slider);

  // Uninstall button
  const uninstallBtn = document.createElement("button");
  uninstallBtn.className = "btn-uninstall";
  uninstallBtn.textContent = "Uninstall";
  uninstallBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({
      type: "marketplace:uninstall",
      key: pkg.key,
    });
    await loadPackages();
  });

  actions.appendChild(toggle);
  actions.appendChild(uninstallBtn);
  header.appendChild(nameSpan);
  header.appendChild(actions);

  // Description
  const desc = document.createElement("div");
  desc.className = "package-description";
  desc.textContent = manifest.description || "";

  // Meta: author, GitHub link
  const meta = document.createElement("div");
  meta.className = "package-meta";

  if (manifest.author) {
    const authorSpan = document.createElement("span");
    authorSpan.textContent = `by ${manifest.author}`;
    meta.appendChild(authorSpan);
  }

  const githubLink = document.createElement("a");
  githubLink.href = githubUrl;
  githubLink.target = "_blank";
  githubLink.rel = "noopener noreferrer";
  githubLink.textContent = "View on GitHub";
  meta.appendChild(githubLink);

  const installedSpan = document.createElement("span");
  installedSpan.textContent = `Installed ${new Date(pkg.installedAt).toLocaleDateString()}`;
  meta.appendChild(installedSpan);

  // Scripts detail
  const scriptsDetail = document.createElement("details");
  scriptsDetail.className = "package-scripts";
  const summary = document.createElement("summary");
  summary.textContent = `${manifest.scripts.length} script${manifest.scripts.length === 1 ? "" : "s"}`;
  scriptsDetail.appendChild(summary);

  for (const script of manifest.scripts) {
    const item = document.createElement("div");
    item.className = "script-item";

    const sName = document.createElement("div");
    sName.className = "script-name";
    sName.textContent = script.name || script.id;
    item.appendChild(sName);

    if (script.description) {
      const sDesc = document.createElement("div");
      sDesc.textContent = script.description;
      item.appendChild(sDesc);
    }

    const sMatches = document.createElement("div");
    sMatches.className = "script-matches";
    sMatches.textContent = script.matches.join(", ");
    item.appendChild(sMatches);

    scriptsDetail.appendChild(item);
  }

  card.appendChild(header);
  card.appendChild(desc);
  card.appendChild(meta);
  card.appendChild(scriptsDetail);

  return card;
}

// --- Theme switcher ---

function applyTheme(theme) {
  if (theme === "auto") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }

  for (const btn of document.querySelectorAll(".theme-btn")) {
    btn.classList.toggle("active", btn.dataset.theme === theme);
  }

  localStorage.setItem("webmcp-theme", theme);
}

for (const btn of document.querySelectorAll(".theme-btn")) {
  btn.addEventListener("click", () => applyTheme(btn.dataset.theme));
}

applyTheme(localStorage.getItem("webmcp-theme") || "auto");

// --- Init ---

loadPackages();
