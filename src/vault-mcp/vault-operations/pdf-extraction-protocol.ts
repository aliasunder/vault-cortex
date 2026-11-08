import { z } from "zod"

const requestFields = {
  requestId: z.number().int().nonnegative(),
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
  }),
  z.object({
    kind: z.literal("index-result"),
    requestId: z.number(),
    result: z.object({ text: z.string(), totalPages: z.number() }),
  }),
  z.object({ kind: z.literal("read-result"), requestId: z.number(), result: textResultSchema }),
  z.object({
    kind: z.literal("failure"),
    requestId: z.number(),
    code: z.enum(["read", "parse", "size"]),
    message: z.string(),
    systemError: z.object({ code: z.string(), syscall: z.string() }).optional(),
  }),
])

export type PdfRequest = z.infer<typeof pdfRequestSchema>
export type PdfReply = z.infer<typeof pdfReplySchema>
