import { resolve } from "node:path"

import { buildLocalEnv, buildRemoteEnv } from "./env.js"
import { buildLocalPayoff, buildRemotePayoff } from "./messages.js"
import { OBSIDIAN_SYNC_IMAGE, pollHealth, type DockerRunner } from "./docker.js"
import {
  planFiles,
  writeFiles,
  type FileWriteResult,
  type Mode,
} from "./scaffold.js"
import { generateToken } from "./token.js"
import { validateVaultPath } from "./vault.js"
import type { Prompts } from "./prompts.js"

export type InitFlags = {
  mode?: string
  vaultPath?: string
  dir?: string
  yes?: boolean
}

export type InitDeps = {
  prompts: Prompts
  docker: DockerRunner
  fetchFn: typeof fetch
}

const DEFAULT_TARGET_DIR = "./vault-cortex"
const HEALTH_URL = "http://127.0.0.1:8000/healthz"

const GET_TOKEN_COMMAND = `docker run --rm -it --entrypoint get-token \\
  ${OBSIDIAN_SYNC_IMAGE}`

/**
 * Asks for the vault path, recursing to re-prompt until it gets a usable
 * answer. A path that doesn't exist is a hard error (likely a typo); a
 * directory without .obsidian/ is only a soft warning, because vault-cortex
 * works on any folder of Markdown files — the confirm (defaulting to yes)
 * exists to catch mistyped paths, not to block non-Obsidian folders.
 */
const askVaultPath = async (prompts: Prompts): Promise<string> => {
  const answer = await prompts.text("Path to your Obsidian vault:", {
    placeholder: "/Users/you/Documents/MyVault",
  })
  const validation = validateVaultPath(answer)
  if (validation.kind === "error") {
    prompts.error(validation.message)
    return askVaultPath(prompts)
  }
  if (validation.kind === "warn") {
    // Renders as: "<path> doesn't look like an Obsidian vault (no .obsidian
    // folder). Use it anyway? (Y/n)"
    const useAnyway = await prompts.confirm(
      `${validation.message} Use it anyway?`,
      true,
    )
    if (!useAnyway) return askVaultPath(prompts)
  }
  return validation.path
}

/** Re-prompts until the answer is a plausible http(s) URL. */
const askPublicUrl = async (prompts: Prompts): Promise<string> => {
  const answer = await prompts.text(
    "Public URL clients will use to reach this server:",
    {
      placeholder: "https://vault.example.com or http://203.0.113.10:8000",
    },
  )
  const trimmed = answer.trim()
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    prompts.error("PUBLIC_URL must start with http:// or https://")
    return askPublicUrl(prompts)
  }
  return trimmed.replace(/\/+$/, "")
}

/** Re-prompts until non-empty. */
const askVaultName = async (prompts: Prompts): Promise<string> => {
  const answer = await prompts.text(
    "Exact name of your Obsidian vault (case-sensitive):",
  )
  if (answer.trim() === "") {
    prompts.error(
      "VAULT_NAME is required — it must match your vault name in Obsidian Sync.",
    )
    return askVaultName(prompts)
  }
  return answer.trim()
}

const reportWrites = (
  prompts: Prompts,
  targetDir: string,
  results: FileWriteResult[],
): void => {
  for (const result of results) {
    const verb = {
      created: "created",
      unchanged: "unchanged (already up to date)",
      overwritten: "overwritten",
      kept: "kept existing file (new content NOT written)",
    }[result.status]
    prompts.log(`${targetDir}/${result.name} — ${verb}`)
  }
}

/**
 * Offers to start the scaffolded stack, walking a gate ladder where each
 * failed gate degrades to instructions instead of an error: compose
 * installed → daemon running → user consents → compose up succeeds →
 * health check passes. Returns true only when the server is confirmed up;
 * the caller uses that to pick the right payoff message.
 */
const offerComposeUp = async (
  prompts: Prompts,
  docker: DockerRunner,
  fetchFn: typeof fetch,
  targetDir: string,
): Promise<boolean> => {
  if (!docker.isComposeAvailable()) {
    prompts.warn(
      "Docker Compose not found — install Docker to start the server:\n" +
        "https://docs.docker.com/get-docker/",
    )
    return false
  }
  if (!docker.isDaemonRunning()) {
    prompts.warn(
      "Docker is installed but not running — start Docker Desktop (or the\n" +
        "docker service on Linux), then run: docker compose up -d",
    )
    return false
  }
  const startNow = await prompts.confirm(
    "Start the server now? (docker compose up -d)",
    true,
  )
  if (!startNow) return false
  if (!docker.composeUp(targetDir)) {
    prompts.error("docker compose up failed — see output above.")
    return false
  }

  const spinner = prompts.spinner()
  spinner.start(
    "Waiting for the server to come up (first run pulls a ~150MB image)",
  )
  const healthy = await pollHealth(fetchFn, HEALTH_URL)
  if (!healthy) {
    spinner.stop(
      "Server did not respond within 2 minutes — check: docker compose logs",
    )
    return false
  }
  spinner.stop("Server is up — health check passed.")
  return true
}

// Local flow: resolve vault path → resolve target dir → generate token →
// write docker-compose.yml + .env → optionally start the stack → print
// connect instructions. Returns a process exit code.
const runLocalInit = async (
  flags: InitFlags,
  deps: InitDeps,
): Promise<number> => {
  const { prompts, docker, fetchFn } = deps

  // Vault path comes from --vault-path when given and valid; interactive
  // runs fall back to prompting on a bad flag, while --yes must fail hard
  // because there is no prompt to fall back to.
  const vaultPathResult =
    flags.vaultPath === undefined
      ? undefined
      : validateVaultPath(flags.vaultPath)
  if (flags.yes) {
    if (vaultPathResult === undefined || vaultPathResult.kind === "error") {
      prompts.error(vaultPathResult?.message ?? "--yes requires --vault-path.")
      return 1
    }
  }

  const vaultPath =
    vaultPathResult !== undefined && vaultPathResult.kind !== "error"
      ? vaultPathResult.path
      : await askVaultPath(prompts)

  const targetDir = resolve(
    flags.dir ??
      (flags.yes
        ? DEFAULT_TARGET_DIR
        : await prompts.text("Where should I put the config files?", {
            defaultValue: DEFAULT_TARGET_DIR,
            placeholder: DEFAULT_TARGET_DIR,
          })),
  )

  const token = generateToken()
  prompts.log("Generated MCP auth token (saved to .env).")

  // Conflict policy: identical existing files are skipped silently;
  // differing ones prompt per file (default keep). --yes never overwrites —
  // any differing file becomes an exit-1 below, leaving it untouched.
  const files = planFiles(
    "local",
    buildLocalEnv({ mcpAuthToken: token, vaultPath }),
  )
  const resolveConflict = flags.yes
    ? async () => false
    : (name: string) =>
        prompts.confirm(
          `${name} already exists and differs — overwrite?`,
          false,
        )
  const results = await writeFiles(targetDir, files, resolveConflict)
  reportWrites(prompts, targetDir, results)

  const keptConflicts = results.filter((result) => result.status === "kept")
  if (flags.yes && keptConflicts.length > 0) {
    prompts.error(
      `Existing files differ (${keptConflicts.map((result) => result.name).join(", ")}) — refusing to overwrite in --yes mode.`,
    )
    return 1
  }

  // --yes is for scripts/CI, so it never starts Docker.
  const started = flags.yes
    ? false
    : await offerComposeUp(prompts, docker, fetchFn, targetDir)
  prompts.note(buildLocalPayoff({ targetDir, token, started }), "Connect")
  return 0
}

// Remote flow (VPS + Obsidian Sync): resolve target dir → PUBLIC_URL →
// VAULT_NAME → Obsidian Sync token (optionally running get-token via
// Docker) → optional E2E vault password → generate token → write the
// three-service compose + .env → optionally start → print connect
// instructions. Always interactive — the sync-token step can't be defaulted.
const runRemoteInit = async (
  flags: InitFlags,
  deps: InitDeps,
): Promise<number> => {
  const { prompts, docker, fetchFn } = deps

  const targetDir = resolve(
    flags.dir ??
      (await prompts.text("Where should I put the config files?", {
        defaultValue: DEFAULT_TARGET_DIR,
        placeholder: DEFAULT_TARGET_DIR,
      })),
  )

  const publicUrl = await askPublicUrl(prompts)
  const vaultName = await askVaultName(prompts)

  // The Obsidian Sync token comes from an interactive docker run (the
  // get-token entrypoint logs into Obsidian). We print the command, offer to
  // run it when Docker is usable, then ask the user to paste the result —
  // get-token writes to the terminal, so it can't be captured automatically.
  // A blank answer is allowed: the .env is written with an empty
  // OBSIDIAN_AUTH_TOKEN and a fill-this-in comment.
  prompts.note(GET_TOKEN_COMMAND, "Obsidian Sync token — generate once with")
  if (docker.isComposeAvailable() && docker.isDaemonRunning()) {
    const runNow = await prompts.confirm("Run the get-token command now?", true)
    if (runNow && !docker.runGetToken()) {
      prompts.warn(
        "get-token did not complete — you can run it later and edit .env.",
      )
    }
  }
  const obsidianAuthToken = (
    await prompts.text(
      "Paste the Obsidian Sync token (leave blank to fill in .env later):",
      {
        defaultValue: "",
      },
    )
  ).trim()

  const usesEncryption = await prompts.confirm(
    "Does your vault use end-to-end encryption?",
    false,
  )
  const vaultPassword = usesEncryption
    ? await prompts.text("Vault encryption password:")
    : undefined

  const token = generateToken()
  prompts.log("Generated MCP auth token (saved to .env).")

  const envContent = buildRemoteEnv({
    mcpAuthToken: token,
    publicUrl,
    obsidianAuthToken,
    vaultName,
    vaultPassword,
  })
  const files = planFiles("remote", envContent)
  const results = await writeFiles(targetDir, files, (name) =>
    prompts.confirm(`${name} already exists and differs — overwrite?`, false),
  )
  reportWrites(prompts, targetDir, results)

  // Without the sync token the stack can't start (obsidian-sync exits), so
  // only offer compose up when it was provided.
  const started =
    obsidianAuthToken === ""
      ? false
      : await offerComposeUp(prompts, docker, fetchFn, targetDir)
  prompts.note(
    buildRemotePayoff({
      targetDir,
      token,
      publicUrl,
      started,
      obsidianTokenMissing: obsidianAuthToken === "",
    }),
    "Connect",
  )
  return 0
}

export const runInit = async (
  flags: InitFlags,
  deps: InitDeps,
): Promise<number> => {
  const { prompts } = deps

  if (
    flags.mode !== undefined &&
    flags.mode !== "local" &&
    flags.mode !== "remote"
  ) {
    prompts.error(
      `Unknown mode "${flags.mode}" — expected "local" or "remote".`,
    )
    return 1
  }
  if (flags.yes && flags.mode === "remote") {
    prompts.error(
      "--yes only supports local mode — remote setup needs interactive token prompts.",
    )
    return 1
  }
  if (flags.yes && flags.vaultPath === undefined) {
    prompts.error("--yes requires --vault-path.")
    return 1
  }

  prompts.intro("vault-cortex init")

  // Mode resolution: explicit --mode wins; --yes implies local (validated
  // above); otherwise ask, defaulting to local — it's the activation path.
  const mode: Mode =
    (flags.mode as Mode | undefined) ??
    (flags.yes
      ? "local"
      : ((await prompts.select(
          "How do you want to run Vault Cortex?",
          [
            {
              value: "local",
              label: "Local",
              hint: "Docker on this machine, bind-mounted vault",
            },
            {
              value: "remote",
              label: "Remote",
              hint: "VPS + Obsidian Sync, access from anywhere",
            },
          ],
          "local",
        )) as Mode))

  const exitCode =
    mode === "local"
      ? await runLocalInit(flags, deps)
      : await runRemoteInit(flags, deps)
  if (exitCode === 0) prompts.outro("Done.")
  return exitCode
}
