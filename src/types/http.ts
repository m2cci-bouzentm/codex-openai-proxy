export interface RequestCancellation {
  signal: AbortSignal;
  abort: () => void;
  dispose: () => void;
  reset?: () => void;
}
