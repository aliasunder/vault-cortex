/** Root ignores file permissions, so a test that denies access and expects the
 *  access to fail can't pass as root. Skip it there; CI runs as a normal user. */
export const runsAsRoot = process.getuid?.() === 0
