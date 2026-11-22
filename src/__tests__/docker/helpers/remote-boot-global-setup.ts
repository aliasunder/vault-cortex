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
import type { TestProject } from "vitest/node"
import { describeError } from "../../../utils/describe-error.js"
// The harness calls Vitest's `inject` only inside its functions, so importing
// it here, outside a test worker, is safe.
import { containerLogs, docker, outputLines, runLabel } from "../docker-harness.js"

// Vitest types `provide` and `inject` by merging into this interface, which a
// type alias cannot do.
declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- declaration merging needs an interface
  export interface ProvidedContext {
    remoteImage: string
    remoteBootRunId: string
  }
}

/** Prints a line to the test run's output, which is where a contributor or a
 *  CI log reads the run ID and the teardown's diagnostics. */
const printLine = (line: string): void => {
  // eslint-disable-next-line no-console -- this output is the run's report to the person or CI log running it
  console.log(line)
}

/** Builds the image with its output on the terminal, so a long or failing
 *  build is visible as it happens. */
const buildRunImage = async ({
  image,
  repositoryRoot,
}: {
  image: string
  repositoryRoot: string
}): Promise<void> => {
  const build = spawn("docker", ["build", "--target", "remote", "-t", image, "."], {
    cwd: repositoryRoot,
    stdio: "inherit",
  })
  const [exitCode, signal] = await once(build, "close")

  if (signal) throw new Error(`docker build of ${image} was killed by ${signal}`)
  if (exitCode !== 0) throw new Error(`docker build of ${image} exited ${exitCode}`)
}

/** Prints a leftover container's state and logs. A failed diagnostic is
 *  printed in their place, so it never stops the container's removal. */
const printContainerDiagnostics = async (containerId: string): Promise<void> => {
  const state = await docker(["inspect", "-f", "{{.Name}} {{json .State}}", containerId])
  printLine(
    state.code === 0
      ? `leftover container ${state.stdout.trim()}`
      : `could not inspect leftover container ${containerId}: ${state.stderr.trim()}`,
  )

  // containerLogs throws when `docker logs` fails or its output passes the
  // harness's buffer limit, so the failure is printed here instead.
  try {
    printLine(await containerLogs(containerId))
  } catch (error) {
    printLine(`could not read the logs of ${containerId}: ${describeError(error)}`)
  }
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
  const runLabelFilter = `label=${runLabel(runId)}`
  // Collected rather than thrown at once, so one failed removal never stops
  // the rest of the sweep.
  const failures: string[] = []
  const removed: string[] = []

  const containerListing = await docker(["ps", "-aq", "--filter", runLabelFilter])

  if (containerListing.code !== 0) {
    failures.push(`listing containers: ${containerListing.stderr.trim()}`)
  }

  for (const containerId of outputLines(containerListing.stdout)) {
    await printContainerDiagnostics(containerId)

    const removal = await docker(["rm", "-f", "-v", containerId])

    if (removal.code !== 0) {
      failures.push(`container ${containerId}: ${removal.stderr.trim()}`)
      continue
    }
    removed.push(`leftover container ${containerId}`)
  }

  // Volumes and the image stay in use until the containers that mount or run
  // them are gone, so they are removed only after the containers.
  const volumeListing = await docker(["volume", "ls", "-q", "--filter", runLabelFilter])

  if (volumeListing.code !== 0) failures.push(`listing volumes: ${volumeListing.stderr.trim()}`)

  for (const volumeName of outputLines(volumeListing.stdout)) {
    const removal = await docker(["volume", "rm", "-f", volumeName])

    if (removal.code !== 0) {
      failures.push(`volume ${volumeName}: ${removal.stderr.trim()}`)
      continue
    }
    removed.push(`volume ${volumeName}`)
  }

  if (ownedImage) {
    const removal = await docker(["image", "rm", ownedImage])

    if (removal.code === 0) removed.push(`image ${ownedImage}`)
    else failures.push(`image ${ownedImage}: ${removal.stderr.trim()}`)
  }

  printLine(`remote-boot run ${runId}: removed ${removed.length} Docker object(s)`)
  for (const removedObject of removed) printLine(`  ${removedObject}`)

  if (failures.length > 0) {
    throw new Error(`remote-boot run ${runId} left Docker objects behind:\n${failures.join("\n")}`)
  }
}

const setup = async (project: TestProject): Promise<() => Promise<void>> => {
  const runId = randomUUID()
  const suppliedImage = process.env.REMOTE_IMAGE
  const buildsOwnImage = !suppliedImage
  const image = suppliedImage || `vault-cortex:remote-boot-${runId}`

  printLine(
    `remote-boot run ${runId}: Docker objects carry the label ${runLabel(runId)} (see CONTRIBUTING.md to remove them after a killed run)`,
  )

  if (buildsOwnImage) await buildRunImage({ image, repositoryRoot: project.config.root })

  project.provide("remoteImage", image)
  project.provide("remoteBootRunId", runId)

  return () => removeRunObjects({ runId, ownedImage: buildsOwnImage ? image : undefined })
}

export default setup
