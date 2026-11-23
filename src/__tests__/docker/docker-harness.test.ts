/** Remote-boot harness tests — the two error paths of `runContainer` that the
 *  boot scenarios never take: removing a container whose start failed after
 *  Docker created it, and refusing a named volume this run did not create.
 *  Needs Docker, like the rest of the remote-boot tier. */

import { randomBytes } from "node:crypto"
import { DateTime } from "luxon"
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

const allVolumes = async (): Promise<string[]> => {
  const listing = await dockerOrThrow(["volume", "ls", "-q"])
  return outputLines(listing).toSorted()
}

/** The current time as an RFC 3339 timestamp, which `docker events --since`
 *  and `--until` accept. */
const dockerTimestampNow = (): string => {
  const timestamp = DateTime.utc().toISO()

  if (!timestamp) throw new Error("Luxon could not format the current time")
  return timestamp
}

type EventWindow = { since: string; until: string }

/** Docker's recorded events in the window that match every filter, one line
 *  per event in the given Go template format. */
const eventLines = async ({
  window,
  filters,
  format,
}: {
  window: EventWindow
  filters: string[]
  format: string
}): Promise<string[]> => {
  const filterArgs = filters.flatMap((filter) => ["--filter", filter])
  const listing = await dockerOrThrow([
    "events",
    "--since",
    window.since,
    "--until",
    window.until,
    ...filterArgs,
    "--format",
    format,
  ])
  return outputLines(listing)
}

/** The volumes Docker created inside the window and mounted into the container
 *  named `name`, read from Docker's event log, which still holds them after
 *  the container and volumes are gone. */
const volumesCreatedForContainer = async ({
  name,
  window,
}: {
  name: string
  window: EventWindow
}): Promise<string[]> => {
  // Each line is `<container ID> <container name>`. The container filter also
  // matches longer names that start with this one, so the name is compared
  // exactly here.
  const containerCreations = await eventLines({
    window,
    filters: ["type=container", "event=create", `container=${name}`],
    format: '{{.Actor.ID}} {{index .Actor.Attributes "name"}}',
  })
  const containerIds = containerCreations
    .map((line) => line.split(" "))
    .filter(([, containerName]) => containerName === name)
    .map(([containerId]) => containerId)

  const createdVolumes = await eventLines({
    window,
    filters: ["type=volume", "event=create"],
    format: "{{.Actor.ID}}",
  })

  // Each line is `<volume name> <ID of the container it was mounted into>`.
  const volumeMounts = await eventLines({
    window,
    filters: ["type=volume", "event=mount"],
    format: '{{.Actor.ID}} {{index .Actor.Attributes "container"}}',
  })
  const volumesMountedIntoContainer = volumeMounts
    .map((line) => line.split(" "))
    .filter(([, containerId]) => containerIds.includes(containerId))
    .map(([volume]) => volume)

  return createdVolumes.filter((volume) => volumesMountedIntoContainer.includes(volume)).toSorted()
}

describe("runContainer", () => {
  it("removes the container and its anonymous volumes when the start fails after Docker created it, and rethrows the start error", async () => {
    const name = uniqueName("failed-start")
    const volumesBefore = await allVolumes()
    const since = dockerTimestampNow()

    // A file mounted over a directory passes `docker create` and fails when
    // the runtime sets up the mounts at start. By then Docker has created the
    // container and the image's three anonymous volumes.
    const start = runContainer({
      name,
      image: IMAGE,
      env: {},
      volumes: ["/etc/hostname:/etc:ro"],
      publishPort: false,
    })

    // "failed to create task" is Docker's start-stage failure, so the
    // container existed before the cleanup ran.
    await expect(start).rejects.toThrow(
      new RegExp(
        `^docker run -d --pull=never --name ${name} .* exited 125: docker: Error response from daemon: failed to create task.*error mounting "/etc/hostname" to rootfs at "/etc"`,
        "s",
      ),
    )
    // The error that reports a failed removal carries the start error as its
    // cause, and the start error itself has none.
    await expect(start).rejects.not.toHaveProperty("cause")

    // Without anonymous volumes, the volume baseline check below would pass
    // whether or not the cleanup removed them. The cleanup has already run,
    // so the event log is the only record that they existed.
    const createdVolumes = await volumesCreatedForContainer({
      name,
      window: { since, until: dockerTimestampNow() },
    })
    expect(createdVolumes.length).toBeGreaterThan(0)

    expect(await containersNamed(name)).toEqual([])
    expect(await allVolumes()).toEqual(volumesBefore)
  })

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
