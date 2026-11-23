/** Remote-boot harness tests — the error path of `runContainer` that the boot
 *  scenarios never take: refusing a named volume this run did not create.
 *  Needs Docker, like the rest of the remote-boot tier. */

import { randomBytes } from "node:crypto"
import { describe, expect, inject, it, onTestFinished } from "vitest"
import { docker, dockerOrThrow, outputLines, runContainer } from "./docker-harness.js"

const IMAGE = inject("remoteImage")

// Built like the boot scenarios' names, so a reader of `docker ps` can tell
// which run left an object behind.
const RUN_NAME_PREFIX = inject("remoteBootRunId").replaceAll("-", "").slice(0, 12)

const uniqueName = (scenario: string): string => {
  return `remote-boot-${RUN_NAME_PREFIX}-${scenario}-${randomBytes(4).toString("hex")}`
}

/** IDs of every container, in any state, named exactly `name`. */
const containersNamed = async (name: string): Promise<string[]> => {
  // Docker matches the name filter as a regular expression, so the anchors
  // keep a longer name that contains this one out of the result.
  const listing = await dockerOrThrow(["ps", "-aq", "--filter", `name=^${name}$`])
  return outputLines(listing)
}

describe("runContainer", () => {
  it("refuses a named volume that exists without this run's label, leaving the volume as it was", async () => {
    const name = uniqueName("foreign-volume")
    const volume = uniqueName("foreign-volume-data")

    // Created without the run label, as another run or a contributor would.
    await dockerOrThrow(["volume", "create", volume])
    onTestFinished(async () => {
      // A regression that let the boot through would leave a container
      // holding the volume, and the volume cannot be removed while it is in
      // use. `rm -f` of a container that never existed exits non-zero, which
      // is the expected outcome here, so its result is not checked.
      await docker(["rm", "-f", "-v", name])
      await dockerOrThrow(["volume", "rm", volume])
    })

    await expect(
      runContainer({
        name,
        image: IMAGE,
        env: {},
        volumes: [`${volume}:/data`],
        publishPort: false,
      }),
    ).rejects.toThrow(
      new Error(`volume ${volume} exists without this run's vault-cortex.test-run label`),
    )

    expect(await containersNamed(name)).toEqual([])

    // The inspect fails if the volume was removed. Docker prints an
    // unlabelled volume's labels as `null` or `{}`, depending on its version.
    const labelsJson = await dockerOrThrow(["volume", "inspect", "-f", "{{json .Labels}}", volume])
    expect(JSON.parse(labelsJson) ?? {}).toEqual({})
  })
})
