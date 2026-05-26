/**
 * Pkl 設定ファイルの読み込み
 *
 * .nas/config.pkl を --project-dir 付きで pkl eval し、
 * nonce ガードで評価結果の正当性を検証する。
 */

import {
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import type { Config } from "./types.ts";
import { validateConfig } from "./validate.ts";

export { getGlobalConfigDir } from "./paths.ts";

const CONFIG_DIR = ".nas";
const CONFIG_FILENAME = "config.pkl";
const SCHEMA_FILENAME = "Schema.pkl";
const PKL_PROJECT_FILENAME = "PklProject";

/** loadConfig のオプション */
export interface LoadConfigOptions {
  /** 開始ディレクトリ（デフォルト: process.cwd()） */
  startDir?: string;
}

/** 設定ファイルを読み込んで検証済み Config を返す */
export async function loadConfig(
  startDirOrOpts?: string | LoadConfigOptions,
): Promise<Config> {
  const opts: LoadConfigOptions =
    typeof startDirOrOpts === "string"
      ? { startDir: startDirOrOpts }
      : (startDirOrOpts ?? {});

  const found = await findConfigFile(opts.startDir ?? process.cwd());

  if (!found) {
    throw new Error(
      `.nas/config.pkl not found in current directory or any parent directory. Run "nas config init" to create one.`,
    );
  }

  const raw = await evalPklConfig(found.nasDir, found.configPath);
  return validateConfig(raw as Config);
}

/** 設定ファイルの検索結果 */
interface ConfigFileFound {
  /** .nas ディレクトリの絶対パス */
  nasDir: string;
  /** .nas/config.pkl の絶対パス */
  configPath: string;
}

/** 指定ディレクトリから上位に向かって .nas/config.pkl を探す */
async function findConfigFile(dir: string): Promise<ConfigFileFound | null> {
  let current = path.resolve(dir);
  const root = path.parse(current).root;

  while (true) {
    const nasDir = path.join(current, CONFIG_DIR);
    const candidate = path.join(nasDir, CONFIG_FILENAME);
    try {
      await stat(candidate);
      return { nasDir, configPath: candidate };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current || current === root) {
      return null;
    }
    current = parent;
  }
}

/** pkl コマンドが PATH 上に存在するか確認する */
async function pklCommandExists(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["pkl", "--version"], {
      stdout: "ignore",
      stderr: "ignore",
      env: process.env,
    });
    const code = await proc.exited;
    return code === 0;
  } catch (e) {
    if (
      e instanceof Error &&
      "code" in e &&
      (e as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw e;
  }
}

/** 暗号学的に安全なランダム nonce を生成する */
function generateNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * .nas/config.pkl を pkl eval --project-dir で評価して設定オブジェクトを得る。
 *
 * nonce ガード（一時ディレクトリ方式）:
 *   1. .nas/.eval-<random>/ 一時ディレクトリを作成
 *   2. Schema.pkl をコピーし _nasNonce にランダム nonce をパッチ
 *   3. PklProject をコピー
 *   4. config.pkl へのシンボリックリンクを作成
 *   5. pkl eval --project-dir .nas/.eval-<random>/ で評価
 *   6. JSON 出力の _nasNonce が書き込んだ nonce と一致することを検証
 *   7. finally で一時ディレクトリを削除
 *
 * 元の .nas/Schema.pkl は一切変更されず、concurrent な呼び出しも安全。
 */
async function evalPklConfig(
  nasDir: string,
  configPath: string,
): Promise<unknown> {
  if (!(await pklCommandExists())) {
    throw new Error(
      `Found .nas/config.pkl at ${configPath}, but 'pkl' command is not available on PATH. Install Pkl (https://pkl-lang.org/main/current/pkl-cli/index.html#installation).`,
    );
  }

  const schemaPath = path.join(nasDir, SCHEMA_FILENAME);
  let originalSchemaText: string;
  try {
    originalSchemaText = await readFile(schemaPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Schema.pkl not found at ${schemaPath}. Run "nas config init" to regenerate it.`,
      );
    }
    throw e;
  }

  const nonce = generateNonce();
  const noncePattern = /^(_nasNonce:\s*String\s*=\s*)"[^"]*"/m;
  const patchedSchemaText = originalSchemaText.replace(
    noncePattern,
    `$1"${nonce}"`,
  );
  if (patchedSchemaText === originalSchemaText) {
    throw new Error(
      `Schema.pkl at ${schemaPath} does not contain a _nasNonce field. Run "nas config init" to regenerate it.`,
    );
  }

  // 一時ディレクトリを作成し、パッチ済み Schema.pkl + PklProject + config.pkl symlink を配置
  const evalDirName = `.eval-${nonce.slice(0, 16)}`;
  const evalDir = path.join(nasDir, evalDirName);
  await mkdir(evalDir, { recursive: true });

  try {
    // パッチ済み Schema.pkl を一時ディレクトリに書き込む
    await writeFile(path.join(evalDir, SCHEMA_FILENAME), patchedSchemaText);

    // PklProject をコピー
    const pklProjectPath = path.join(nasDir, PKL_PROJECT_FILENAME);
    let pklProjectText: string;
    try {
      pklProjectText = await readFile(pklProjectPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `PklProject not found at ${pklProjectPath}. Run "nas config init" to regenerate it.`,
        );
      }
      throw e;
    }
    await writeFile(path.join(evalDir, PKL_PROJECT_FILENAME), pklProjectText);

    // config.pkl へのシンボリックリンクを作成
    const symlinkPath = path.join(evalDir, CONFIG_FILENAME);
    await symlink(configPath, symlinkPath);

    const cmdArgs = [
      "pkl",
      "eval",
      "--project-dir",
      evalDir,
      "-f",
      "json",
      symlinkPath,
    ];

    const proc = Bun.spawn(cmdArgs, {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [stdoutText, stderrText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0) {
      const errMsg = stderrText.trim();
      throw new Error(
        `Failed to evaluate ${configPath}: pkl eval exited with code ${code}\n${errMsg}`,
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdoutText) as Record<string, unknown>;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Failed to parse pkl output for ${configPath}: ${message}\nstdout: ${stdoutText.slice(0, 500)}`,
      );
    }

    // nonce ガード検証
    if (parsed._nasNonce !== nonce) {
      throw new Error(
        `Nonce verification failed for ${configPath}. The evaluated config did not produce the expected nonce. ` +
          `This may indicate the config file does not properly inherit from Schema.pkl.`,
      );
    }

    // _nasNonce を除去してから返す
    const { _nasNonce: _, ...configWithoutNonce } = parsed;
    return configWithoutNonce;
  } finally {
    // 一時ディレクトリを削除（best-effort: 失敗してもオリジナルのエラーを隠さない）
    try {
      await rm(evalDir, { recursive: true, force: true });
    } catch {
      // cleanup failure is non-fatal — do not mask the original error
    }
  }
}

/** プロファイルを解決 (名前指定 or default) */
export function resolveProfile(config: Config, profileName?: string) {
  const name = profileName ?? config.default;
  if (!name) {
    const names = Object.keys(config.profiles);
    if (names.length === 1) {
      return { name: names[0], profile: config.profiles[names[0]] };
    }
    throw new Error(
      "No profile specified and no default set. Available: " +
        Object.keys(config.profiles).join(", "),
    );
  }

  const profile = config.profiles[name];
  if (!profile) {
    throw new Error(
      `Profile "${name}" not found. Available: ${Object.keys(
        config.profiles,
      ).join(", ")}`,
    );
  }
  return { name, profile };
}
