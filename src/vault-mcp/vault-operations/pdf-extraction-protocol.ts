import { z } from "zod"

const requestId = z.number().int().nonnegative()

const requestFields = {
  requestId,
  vaultPath: z.string(),
  path: z.string(),
  maxFileBytes: z.number().nonnegative(),
}

export const pdfRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("index"), ...requestFields }),
  z.object({
    kind: z.literal("read"),
    ...requestFields,
    startLine: z.number().optional(),
    limit: z.number().optional(),
  }),
])

const textResultSchema = z.object({
  kind: z.literal("text"),
  text: z.string(),
  path: z.string(),
  lineWindow: z
    .object({
      startLine: z.number(),
      endLine: z.number(),
      totalLines: z.number(),
    })
    .optional(),
})

export const pdfReplySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ready"),
    oomPreference: z.enum(["applied", "unavailable", "unsupported"]),
    /** Why the preference is unavailable; the child's own log never reaches a sink. */
    oomPreferenceError: z.string().optional(),
  }),
  z.object({
    kind: z.literal("index-result"),
    requestId,
    result: z.object({ text: z.string(), totalPages: z.number() }),
  }),
  z.object({ kind: z.literal("read-result"), requestId, result: textResultSchema }),
  z.object({
    kind: z.literal("failure"),
    requestId,
    /** The error's class name, so the parent rebuilds the error the tool boundary would have seen. */
    name: z.string(),
    message: z.string(),
    cause: z.string().optional(),
    systemError: z.object({ code: z.string(), syscall: z.string() }).optional(),
  }),
])

export type PdfRequest = z.infer<typeof pdfRequestSchema>
export type PdfReply = z.infer<typeof pdfReplySchema>
