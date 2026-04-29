export class WatchesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchesConfigError";
  }
}
