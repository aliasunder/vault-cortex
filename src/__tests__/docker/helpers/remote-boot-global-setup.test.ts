/** Remote-boot global teardown tests — `removeRunObjects` removes exactly the
 *  Docker objects of one run: its labelled containers with their anonymous
 *  volumes, its labelled volumes, and the image it built. Each test sweeps a
 *  run ID of its own, never the current run's. Needs Docker, like the rest of
 *  the remote-boot tier. */

import { randomBytes, randomUUID } from "node:crypto"
import { describe, expect, inject, it, onTestFinished, vi } from "vitest"
import { docker, dockerOrThrow, outputLines, runLabel } from "../docker-harness.js"
import { removeRunObjects } from "./remote-boot-global-setup.js"

const IMAGE = inject("remoteImage")

// Built like the boot scenarios' names, so a reader of `docker ps` can tell
// which run left an object behind.
const RUN_NAME_PREFIX = inject("remoteBootRunId").replaceAll("-", "").slice(0, 12)

const uniqueName = (scenario: string): string => {
  return `remote-boot-${RUN_NAME_PREFIX}-${scenario}-${randomBytes(4).toString("hex")}`
}

/** IDs of every container, in any state, named exactly `name`, as `docker ps`
 *  prints them. */
const containersNamed = async (name: string): Promise<string[]> => {
  // Docker matches the name filter as a regular expression, so the anchors
  // keep a longer name that contains this one out of the result.
  const listing = await dockerOrThrow(["ps", "-aq", "--filter", `name=^${name}$`])
  return outputLines(listing)
}

const allVolumes = async (): Promise<string[]> => {
  const listing = await dockerOrThrow(["volume", "ls", "-q"])
  return outputLines(listing).toSorted()
}

/** Collects the lines `removeRunObjects` prints to the console, keeping them
 *  out of the test output. */
const capturePrintedLines = (): string[] => {
  const printedLines: string[] = []
  const logSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    printedLines.push(String(line))
  })
  onTestFinished(() => {
    logSpy.mockRestore()
  })
  return printedLines
}

describe("removeRunObjects", () => {
  it("removes the run's labelled containers with their anonymous volumes and its labelled volumes, prints each container's state first, and leaves unlabelled containers alone", async () => {
    const runId = randomUUID()
    const label = runLabel(runId)

    // Created before the volume baseline below, so the decoy's own anonymous
    // volumes are part of it.
    const decoyName = uniqueName("teardown-decoy")
    await dockerOrThrow(["create", "--pull=never", "--name", decoyName, IMAGE])
    onTestFinished(async () => {
      await dockerOrThrow(["rm", "-f", "-v", decoyName])
    })
    const decoyIds = await containersNamed(decoyName)

    const volumesBefore = await allVolumes()

    // The teardown under test should already have removed the labelled volume
    // and container, and `rm` of a missing object exits non-zero, so these
    // backstops do not check their results. Vitest runs onTestFinished
    // callbacks in reverse order, so the container goes before the volume it
    // mounts.
    const labelledVolume = uniqueName("teardown-volume")
    await dockerOrThrow(["volume", "create", "--label", label, labelledVolume])
    onTestFinished(async () => {
      await docker(["volume", "rm", "-f", labelledVolume])
    })

    // Created, never started: the image's declared volumes become the
    // container's anonymous volumes, and the labelled volume stays in use
    // until the container is gone.
    const leftoverName = uniqueName("teardown-leftover")
    await dockerOrThrow([
      "create",
      "--pull=never",
      "--name",
      leftoverName,
      "--label",
      label,
      "-v",
      `${labelledVolume}:/teardown-volume`,
      IMAGE,
    ])
    onTestFinished(async () => {
      await docker(["rm", "-f", "-v", leftoverName])
    })

    // Without anonymous volumes, the volume baseline check below would pass
    // whether or not the container's removal took them.
    const anonymousVolumes = (await allVolumes()).filter(
      (volume) => !volumesBefore.includes(volume) && volume !== labelledVolume,
    )
    expect(anonymousVolumes.length).toBeGreaterThan(0)

    const leftoverIds = await containersNamed(leftoverName)
    const leftoverState = await dockerOrThrow(["inspect", "-f", "{{json .State}}", leftoverName])
    const printedLines = capturePrintedLines()

    await removeRunObjects({ runId, ownedImage: undefined })

    expect(await containersNamed(decoyName)).toEqual(decoyIds)
    expect(await dockerOrThrow(["ps", "-aq", "--filter", `label=${label}`])).toBe("")
    expect(await dockerOrThrow(["volume", "ls", "-q", "--filter", `label=${label}`])).toBe("")
    expect(await allVolumes()).toEqual(volumesBefore)
    expect(printedLines).toEqual([
      `leftover container /${leftoverName} ${leftoverState.trim()}`,
      // A container that never started has empty logs.
      "",
      `remote-boot run ${runId}: removed 2 Docker object(s)`,
      ...leftoverIds.map((containerId) => `  leftover container ${containerId}`),
      `  volume ${labelledVolume}`,
    ])
  })

  it("removes the image the run built, leaving the image it was tagged from", async () => {
    const runId = randomUUID()
    const ownedImage = `vault-cortex:${uniqueName("teardown-owned")}`
    const sourceImageId = await dockerOrThrow(["image", "inspect", "-f", "{{.Id}}", IMAGE])

    await dockerOrThrow(["tag", IMAGE, ownedImage])
    onTestFinished(async () => {
      // The teardown under test should already have removed the tag, so a
      // non-zero exit is the expected outcome and is not checked.
      await docker(["image", "rm", ownedImage])
    })
    const printedLines = capturePrintedLines()

    await removeRunObjects({ runId, ownedImage })

    expect(printedLines).toEqual([
      `remote-boot run ${runId}: removed 1 Docker object(s)`,
      `  image ${ownedImage}`,
    ])
    expect(await dockerOrThrow(["image", "ls", "-q", ownedImage])).toBe("")
    expect(await dockerOrThrow(["image", "inspect", "-f", "{{.Id}}", IMAGE])).toBe(sourceImageId)
  })
})
