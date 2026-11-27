import { app } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface DshPluginInstallStatus {
  dshDetected: boolean;
  installed: boolean;
  justInstalled: boolean;
  needsDshRestart: boolean;
  version?: string;
  message: string;
}

const PLUGIN_NAME = 'dsh-stocking-quota-bridge';

function getDshHome(): string {
  return path.join(os.homedir(), '.dsh');
}

function resolveBundledPluginDir(appRoot: string): string | null {
  const candidates = [
    path.join(appRoot, 'dsh-plugin', PLUGIN_NAME).replace('app.asar', 'app.asar.unpacked'),
    path.join(appRoot, 'dsh-plugin', PLUGIN_NAME),
    path.join(process.cwd(), 'dsh-plugin', PLUGIN_NAME),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'package.json'))) return c;
  }
  return null;
}

function resolveStockingQuotaExePath(): string {
  if (app.isPackaged) {
    return process.execPath.replace(/\\/g, '/');
  }
  const devBuilt = path.join(process.cwd(), 'release', 'win-unpacked', 'StockingQuota.exe');
  if (fs.existsSync(devBuilt)) {
    return devBuilt.replace(/\\/g, '/');
  }
  return process.execPath.replace(/\\/g, '/');
}

/**
 * Writes JSON strictly as UTF-8 WITHOUT BOM and verifies JSON.parse before returning.
 * Prevents the Windows PowerShell UTF-8 BOM bug that broke DSH startup!
 */
function writeJsonNoBomVerified(filePath: string, obj: unknown): void {
  const text = `${JSON.stringify(obj, null, 2)}\n`;
  JSON.parse(text); // sanity check before touching disk
  const tmpPath = `${filePath}.sq-tmp`;
  fs.writeFileSync(tmpPath, text, { encoding: 'utf8' });
  const verifyBuf = fs.readFileSync(tmpPath);
  if (verifyBuf.length >= 3 && verifyBuf[0] === 0xef && verifyBuf[1] === 0xbb && verifyBuf[2] === 0xbf) {
    fs.unlinkSync(tmpPath);
    throw new Error('Unexpected BOM detected while writing DSH profile JSON');
  }
  fs.renameSync(tmpPath, filePath);
}

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * Safely removes a directory junction/symlink WITHOUT following it into the target directory!
 * CRITICAL on Windows: Electron's asar-patched `fs.rmSync(junction, { recursive: true })` can delete
 * the junction target's contents! Always use `lstatSync` + `rmdirSync`/`unlinkSync` for junctions.
 */
function safeRemoveJunctionOrDir(targetPath: string): void {
  try {
    const st = fs.lstatSync(targetPath);
    if (st.isSymbolicLink()) {
      try {
        fs.unlinkSync(targetPath);
      } catch {
        fs.rmdirSync(targetPath);
      }
    } else if (st.isDirectory()) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(targetPath);
    }
  } catch {
    // ENOENT or already removed
  }
}

function updateDshProfile(dshHome: string, profileName: string, dstPluginDir: string, remove: boolean): boolean {
  const profDir = path.join(dshHome, 'profiles', profileName);
  const pkgPath = path.join(profDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;

  const raw = fs.readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, '');
  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    dsh?: { profile?: { bundles?: string[] } };
  };

  // One-time safety backup before first modification
  const backupPath = `${pkgPath}.bak-pre-stocking`;
  if (!remove && !fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, raw, 'utf8');
  }

  if (!pkg.dependencies) pkg.dependencies = {};
  if (!pkg.dsh) pkg.dsh = {};
  if (!pkg.dsh.profile) pkg.dsh.profile = {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? [...pkg.dsh.profile.bundles] : [];
  const nmDir = path.join(profDir, 'node_modules');
  const nmLink = path.join(nmDir, PLUGIN_NAME);

  if (remove) {
    delete pkg.dependencies[PLUGIN_NAME];
    pkg.dsh.profile.bundles = bundles.filter((b) => b !== PLUGIN_NAME);
    safeRemoveJunctionOrDir(nmLink);
  } else {
    const linkVal = `link:${dstPluginDir.replace(/\\/g, '/')}`;
    pkg.dependencies[PLUGIN_NAME] = linkVal;
    if (!bundles.includes(PLUGIN_NAME)) {
      bundles.push(PLUGIN_NAME);
    }
    pkg.dsh.profile.bundles = bundles;

    if (fs.existsSync(nmDir)) {
      // Check if an existing junction already points directly to dstPluginDir -> leave it intact!
      let alreadyLinked = false;
      try {
        const st = fs.lstatSync(nmLink);
        if (st.isSymbolicLink() && fs.realpathSync(nmLink).toLowerCase() === path.resolve(dstPluginDir).toLowerCase()) {
          alreadyLinked = true;
        }
      } catch {
        // not linked yet
      }

      if (!alreadyLinked) {
        safeRemoveJunctionOrDir(nmLink);
        try {
          fs.symlinkSync(dstPluginDir, nmLink, 'junction');
        } catch {
          copyDirRecursive(dstPluginDir, nmLink);
        }
      }
    }
  }

  writeJsonNoBomVerified(pkgPath, pkg);
  return true;
}

/**
 * Automatically detects whether DeepSeek Harness is installed on this PC and installs/updates
 * the zero-UI `dsh-stocking-quota-bridge` plugin silently without touching DSH's installation directory.
 */
export function ensureDshBridgeInstalled(appRoot: string, forceReinstall = false): DshPluginInstallStatus {
  const dshHome = getDshHome();
  if (!fs.existsSync(dshHome)) {
    return {
      dshDetected: false,
      installed: false,
      justInstalled: false,
      needsDshRestart: false,
      message: '未检测到 DeepSeek Harness',
    };
  }

  const srcDir = resolveBundledPluginDir(appRoot);
  if (!srcDir) {
    return {
      dshDetected: true,
      installed: false,
      justInstalled: false,
      needsDshRestart: false,
      message: '未找到内置 DSH 桥接插件资源',
    };
  }

  const dstDir = path.join(dshHome, 'plugins', PLUGIN_NAME);
  const exePath = resolveStockingQuotaExePath();
  let bundledVersion = '0.3.1';
  try {
    const srcPkg = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8')) as { version?: string };
    if (srcPkg.version) bundledVersion = srcPkg.version;
  } catch {
    // ignore
  }

  // Check if already up-to-date, complete on disk, AND registered in desktop profile
  if (
    !forceReinstall &&
    fs.existsSync(path.join(dstDir, 'package.json')) &&
    fs.existsSync(path.join(dstDir, 'lib', 'index.js')) &&
    fs.existsSync(path.join(dstDir, 'lib', 'client.js')) &&
    fs.existsSync(path.join(dstDir, 'cordis.patch.yml'))
  ) {
    try {
      const dstPkg = JSON.parse(fs.readFileSync(path.join(dstDir, 'package.json'), 'utf8')) as { version?: string };
      const patchRaw = fs.readFileSync(path.join(dstDir, 'cordis.patch.yml'), 'utf8');
      const desktopPkgPath = path.join(dshHome, 'profiles', 'desktop', 'package.json');
      const desktopRegistered =
        !fs.existsSync(desktopPkgPath) ||
        fs.readFileSync(desktopPkgPath, 'utf8').includes(PLUGIN_NAME);

      if (dstPkg.version === bundledVersion && patchRaw.includes(exePath) && desktopRegistered) {
        return {
          dshDetected: true,
          installed: true,
          justInstalled: false,
          needsDshRestart: false,
          version: bundledVersion,
          message: 'DSH 蓝丝桥接插件已就绪',
        };
      }
    } catch {
      // fall through to repair/reinstall
    }
  }

  try {
    copyDirRecursive(srcDir, dstDir);

    // Write resolved exe path into cordis.patch.yml strictly UTF-8 without BOM
    const patchText =
      `- insert:\n` +
      `    - id: ${PLUGIN_NAME}\n` +
      `      name: ${PLUGIN_NAME}\n` +
      `      config:\n` +
      `        targetUrl: 'http://127.0.0.1:17821/dsh/context'\n` +
      `        autoLaunch: true\n` +
      `        stockingQuotaExe: '${exePath}'\n`;
    fs.writeFileSync(path.join(dstDir, 'cordis.patch.yml'), patchText, 'utf8');

    updateDshProfile(dshHome, 'desktop', dstDir, false);
    updateDshProfile(dshHome, 'web', dstDir, false);

    // Final integrity check: guarantee plugin files exist on disk after profile linking!
    if (!fs.existsSync(path.join(dstDir, 'package.json')) || !fs.existsSync(path.join(dstDir, 'lib', 'index.js'))) {
      copyDirRecursive(srcDir, dstDir);
      fs.writeFileSync(path.join(dstDir, 'cordis.patch.yml'), patchText, 'utf8');
    }

    return {
      dshDetected: true,
      installed: true,
      justInstalled: true,
      needsDshRestart: true,
      version: bundledVersion,
      message: '已自动配置 DSH 蓝丝桥接插件（重启一次 DSH 即可实时同步）',
    };
  } catch (err) {
    console.warn('[DshPluginInstaller] Auto-install failed:', err);
    return {
      dshDetected: true,
      installed: false,
      justInstalled: false,
      needsDshRestart: false,
      message: 'DSH 插件自动配置失败，可稍后点击重试',
    };
  }
}

export function uninstallDshBridge(): DshPluginInstallStatus {
  const dshHome = getDshHome();
  if (!fs.existsSync(dshHome)) {
    return {
      dshDetected: false,
      installed: false,
      justInstalled: false,
      needsDshRestart: false,
      message: '未检测到 DeepSeek Harness',
    };
  }

  try {
    const dstDir = path.join(dshHome, 'plugins', PLUGIN_NAME);
    updateDshProfile(dshHome, 'desktop', dstDir, true);
    updateDshProfile(dshHome, 'web', dstDir, true);
    if (fs.existsSync(dstDir)) {
      fs.rmSync(dstDir, { recursive: true, force: true });
    }
    return {
      dshDetected: true,
      installed: false,
      justInstalled: false,
      needsDshRestart: true,
      message: '已卸载 DSH 桥接插件（重启 DSH 生效）',
    };
  } catch (err) {
    console.warn('[DshPluginInstaller] Uninstall failed:', err);
    return {
      dshDetected: true,
      installed: false,
      justInstalled: false,
      needsDshRestart: false,
      message: '卸载 DSH 插件失败',
    };
  }
}
