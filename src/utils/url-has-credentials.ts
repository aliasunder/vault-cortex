export const urlHasCredentials = (url: URL): boolean => {
  return Boolean(url.username || url.password)
}
