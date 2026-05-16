import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

const tauriConf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const version = tauriConf.version;
const tag = `v${version}`;
const baseUrl = `https://github.com/jmaitrehenry/karto/releases/download/${tag}`;

const artifactsDir = "artifacts";

function readSig(filePath) {
  return readFileSync(filePath, "utf8").trim();
}

function findFile(dir, ext) {
  try {
    const files = readdirSync(dir);
    const match = files.find((f) => f.endsWith(ext));
    return match ? join(dir, match) : null;
  } catch {
    return null;
  }
}

const platforms = {};

const macTarGz = findFile(`${artifactsDir}/updater-darwin-aarch64`, ".app.tar.gz");
const macSig = findFile(`${artifactsDir}/updater-darwin-aarch64`, ".app.tar.gz.sig");
if (macTarGz && macSig) {
  const filename = macTarGz.split("/").pop();
  platforms["darwin-aarch64"] = {
    signature: readSig(macSig),
    url: `${baseUrl}/${filename}`,
  };
  // Also publish as x86_64 if only one macOS build (universal-ish fallback)
  platforms["darwin-x86_64"] = platforms["darwin-aarch64"];
}

const linuxAppImage = findFile(`${artifactsDir}/updater-linux-x86_64`, ".AppImage");
const linuxSig = findFile(`${artifactsDir}/updater-linux-x86_64`, ".AppImage.sig");
if (linuxAppImage && linuxSig) {
  const filename = linuxAppImage.split("/").pop();
  platforms["linux-x86_64"] = {
    signature: readSig(linuxSig),
    url: `${baseUrl}/${filename}`,
  };
}

const winSetup = findFile(`${artifactsDir}/updater-windows-x86_64`, "-setup.exe");
const winSig = findFile(`${artifactsDir}/updater-windows-x86_64`, "-setup.exe.sig");
if (winSetup && winSig) {
  const filename = winSetup.split("/").pop();
  platforms["windows-x86_64"] = {
    signature: readSig(winSig),
    url: `${baseUrl}/${filename}`,
  };
}

const latestJson = {
  version,
  notes: "",
  pub_date: new Date().toISOString(),
  platforms,
};

writeFileSync("latest.json", JSON.stringify(latestJson, null, 2));
console.log("Generated latest.json:", JSON.stringify(latestJson, null, 2));
