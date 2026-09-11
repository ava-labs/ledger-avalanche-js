import {
  DeviceActionStatus,
  type ExecuteDeviceActionReturnType,
} from "@ledgerhq/device-management-kit";
import type { Signature } from "@ledgerhq/device-signer-kit-ethereum";

/** A running DMK device action whose error and progress types this SDK does not care about. */
export type DeviceActionRun<Output> = ExecuteDeviceActionReturnType<
  Output,
  unknown,
  unknown
>;

/**
 * Raised when a Device Management Kit device action ends in an error state.
 *
 * `statusCode` carries the device's status word whenever the kit reported one (`0x6985`
 * when the user rejected on the device, for instance), so callers can branch on it the way
 * they did with hw-transport's `TransportStatusError`. The kit's own error object is kept
 * in `cause`.
 */
export class DeviceActionError extends Error {
  readonly statusCode: number | undefined;
  readonly cause: unknown;

  constructor(message: string, cause: unknown, statusCode?: number) {
    super(message);
    this.name = "DeviceActionError";
    this.cause = cause;
    this.statusCode = statusCode;
  }
}

/**
 * Runs a device action to completion.
 *
 * Resolves with the action's output, rejects with a `DeviceActionError` if the action
 * errors, is cancelled, or finishes without ever reporting a result.
 */
export function runDeviceAction<Output>(
  run: DeviceActionRun<Output>,
): Promise<Output> {
  return new Promise<Output>((resolve, reject) => {
    run.observable.subscribe({
      next: (state) => {
        switch (state.status) {
          case DeviceActionStatus.Completed:
            resolve(state.output);
            break;
          case DeviceActionStatus.Error:
            reject(toDeviceActionError(state.error));
            break;
          case DeviceActionStatus.Stopped:
            reject(
              new DeviceActionError(
                "Device action was cancelled before it completed",
                undefined,
              ),
            );
            break;
          default:
            // NotStarted / Pending: still running on the device.
            break;
        }
      },
      error: (error) => reject(toDeviceActionError(error)),
      complete: () =>
        reject(
          new DeviceActionError(
            "Device action ended without reporting a result",
            undefined,
          ),
        ),
    });
  });
}

/**
 * Normalises whatever the kit rejected with into a `DeviceActionError`.
 *
 * DMK errors are plain objects tagged with `_tag`, and app-level ones also carry the
 * status word as a hex string in `errorCode`; both are folded into the message and the
 * status word is exposed numerically.
 */
export function toDeviceActionError(error: unknown): DeviceActionError {
  if (error instanceof DeviceActionError) {
    return error;
  }
  const fields =
    typeof error === "object" && error !== null
      ? (error as { _tag?: unknown; errorCode?: unknown; message?: unknown })
      : {};
  const tag = typeof fields._tag === "string" ? fields._tag : undefined;
  const errorCode =
    typeof fields.errorCode === "string" ? fields.errorCode : undefined;
  const message =
    typeof fields.message === "string"
      ? fields.message
      : error instanceof Error
        ? error.message
        : undefined;
  const detail = [tag, errorCode, message]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(": ");
  const statusCode =
    errorCode !== undefined && /^[0-9a-f]{4}$/i.test(errorCode)
      ? parseInt(errorCode, 16)
      : undefined;
  return new DeviceActionError(
    `Device Management Kit signer failed${detail ? `: ${detail}` : ""}`,
    error,
    statusCode,
  );
}

export function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = stripHexPrefix(hex);
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(clean)) {
    throw new Error("Expected an even-length hex string");
  }
  return new Uint8Array(Buffer.from(clean, "hex"));
}

/**
 * The kit wants `44'/60'/0'/0/0`; hw-app-eth also accepted the `m/` prefix the rest of
 * this SDK uses, so keep accepting it.
 */
export function evmDerivationPath(path: string): string {
  return path.startsWith("m/") ? path.slice(2) : path;
}

/**
 * Shapes a kit signature the way `hw-app-eth`'s `signTransaction` returned it: unprefixed
 * hex `r`/`s`, and `v` as even-length hex (`"01"`, `"25"`, `"0150f7"`...).
 */
export function toEvmTransactionSignature(signature: Signature): {
  r: string;
  s: string;
  v: string;
} {
  const v = signature.v.toString(16);
  return {
    r: stripHexPrefix(signature.r),
    s: stripHexPrefix(signature.s),
    v: v.length % 2 === 1 ? `0${v}` : v,
  };
}

/** Shapes a kit signature the way `hw-app-eth`'s EIP-712 methods returned it. */
export function toEvmTypedDataSignature(signature: Signature): {
  r: string;
  s: string;
  v: number;
} {
  return {
    r: stripHexPrefix(signature.r),
    s: stripHexPrefix(signature.s),
    v: signature.v,
  };
}
