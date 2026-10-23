/** Request order is local to a mounted surface; older replies cannot roll it back. */
export function createResponseOrder() {
  let revision = 0;
  return {
    begin: () => ++revision,
    current: (request: number) => request === revision,
    invalidate: () => { revision += 1; },
  };
}
