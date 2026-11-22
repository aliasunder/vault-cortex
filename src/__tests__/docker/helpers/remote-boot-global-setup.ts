/** Remote-boot global setup: one test run owns its image and every Docker
 *  object it labels.
 *  1. Picks a run ID.
 *  2. Builds the `:remote` image under a tag of its own, unless REMOTE_IMAGE
 *     names an image the caller built (CI, or a reused local build).
 *  3. Hands the image and run ID to the tests (`inject`).
 *  4. On teardown, prints then removes every container left with the run's
 *     label, removes the run's labelled volumes, then the image it built. */

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { resolve } from "node:path"
import type { TestProject } from "vitest/node"
import { RUN_LABEL_KEY, docker } from "../docker-harness.js"

// Vitest types `provide` and `inject` by merging into this interface, which a
// type alias cannot do.
declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- declaration merging needs an interface
  export interface ProvidedContext {
    remoteImage: string
    remoteBootRunId: string
  }
}

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../..")

/** Prints a line to the test run's output, which is where a contributor or a
 *  CI log reads the run ID and the teardown's diagnostics. */
const printLine = (line: string): void => {
  // eslint-disable-next-line no-console -- this output is the run's report to the person or CI log running it
  console.log(line)
}

/** Builds the image with its output on the terminal, so a long or failing
 *  build is visible as it happens. */
const buildRunImage = async ({ image, runId }: { image: string; runId: string }): Promise<void> => {
  const build = spawn(
    "docker",
    ["build", "--target", "remote", "--label", `${RUN_LABEL_KEY}=${runId}`, "-t", image, "."],
    { cwd: REPOSITORY_ROOT, stdio: "inherit" },
  )
  const [exitCode] = await once(build, "close")

  if (exitCode !== 0) throw new Error(`docker build of ${image} exited ${exitCode}`)
}

/** Lines of `docker` output, with blank lines dropped. */
const outputLines = (output: string): string[] => output.split("\n").filter(Boolean)

/** Prints a leftover container's state and logs. Each call runs on its own, so
 *  a failed diagnostic is printed and never stops the removal after it. */
const printContainerDiagnostics = async (containerId: string): Promise<void> => {
  const state = await docker(["inspect", "-f", "{{.Name}} {{json .State}}", containerId])
  printLine(
    state.code === 0
      ? `leftover container ${state.stdout.trim()}`
      : `could not inspect leftover container ${containerId}: ${state.stderr.trim()}`,
  )

  const logs = await docker(["logs", containerId])
  printLine(
    logs.code === 0
      ? `${logs.stdout}${logs.stderr}`
      : `could not read the logs of ${containerId}: ${logs.stderr.trim()}`,
  )
}

/** Removes every container and volume labelled with the run ID, then the image
 *  the run built, and throws when any removal failed. A leftover container
 *  means its scenario's own cleanup never ran, so its diagnostics go to the
 *  log first. */
const removeRunObjects = async ({
  runId,
  ownedImage,
}: {
  runId: string
  ownedImage: string | undefined
}): Promise<void> => {
  const runLabelFilter = `label=${RUN_LABEL_KEY}=${runId}`
  // Collected rather than thrown at once, so one failed removal never stops
  // the rest of the sweep.
  const failures: string[] = []

  const containerListing = await docker(["ps", "-aq", "--filter", runLabelFilter])

  if (containerListing.code !== 0)
    failures.push(`listing containers: ${containerListing.stderr.trim()}`)

  const containerIds = outputLines(containerListing.stdout)
  for (const containerId of containerIds) {
    await printContainerDiagnostics(containerId)

    const removal = await docker(["rm", "-f", "-v", containerId])

    if (removal.code !== 0) failures.push(`container ${containerId}: ${removal.stderr.trim()}`)
  }

  const volumeListing = await docker(["volume", "ls", "-q", "--filter", runLabelFilter])

  if (volumeListing.code !== 0) failures.push(`listing volumes: ${volumeListing.stderr.trim()}`)

  const volumeNames = outputLines(volumeListing.stdout)
  for (const volumeName of volumeNames) {
    const removal = await docker(["volume", "rm", "-f", volumeName])

    if (removal.code !== 0) failures.push(`volume ${volumeName}: ${removal.stderr.trim()}`)
  }

  if (ownedImage) {
    const removal = await docker(["image", "rm", ownedImage])

    if (removal.code !== 0) failures.push(`image ${ownedImage}: ${removal.stderr.trim()}`)
  }

  const imageSummary = ownedImage ? `, image ${ownedImage}` : ""
  printLine(
    `remote-boot run ${runId}: removed ${containerIds.length} leftover container(s), ${volumeNames.length} volume(s)${imageSummary}`,
  )

  if (failures.length > 0) {
    throw new Error(`remote-boot run ${runId} left Docker objects behind:\n${failures.join("\n")}`)
  }
}

const setup = async (project: TestProject): Promise<() => Promise<void>> => {
  const runId = randomUUID()
  const suppliedImage = process.env.REMOTE_IMAGE
  const image = suppliedImage ?? `vault-cortex:remote-boot-${runId}`

  printLine(
    `remote-boot run ${runId}: Docker objects carry the label ${RUN_LABEL_KEY}=${runId} (see CONTRIBUTING.md to remove them after a killed run)`,
  )

  if (!suppliedImage) await buildRunImage({ image, runId })

  project.provide("remoteImage", image)
  project.provide("remoteBootRunId", runId)

  return () => removeRunObjects({ runId, ownedImage: suppliedImage ? undefined : image })
}

export default setup
