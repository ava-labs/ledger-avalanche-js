# @zondax/ledger-avalanche-app

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![npm version](https://badge.fury.io/js/%40zondax%2Fledger-avalanche-app.svg)](https://badge.fury.io/js/%40zondax%2Fledger-avalanche-app)

This package provides a basic client library to communicate with the Avalanche App running in a Ledger Nano S/X

We recommend using the npmjs package in order to receive updates/fixes.

## Usage

Connect through Ledger's [Device Management Kit](https://developers.ledger.com/docs/device-interaction/getting-started)
and hand the SDK a `DMKTransport` (from `@zondax/ledger-js`). The X/P-chain methods only
need the transport; the C-Chain (EVM) methods also need the DMK session behind it, because
they are driven by `@ledgerhq/device-signer-kit-ethereum`:

```ts
import { DeviceManagementKitBuilder } from "@ledgerhq/device-management-kit";
import { DMKTransport } from "@zondax/ledger-js";
import AvalancheApp from "@zondax/ledger-avalanche-app";

const dmk = new DeviceManagementKitBuilder()
  .addTransport(/* web-hid, node-hid... */)
  .build();
const sessionId = await dmk.connect({
  device,
  sessionRefresherOptions: { isRefresherDisabled: true },
});

const app = new AvalancheApp(new DMKTransport(dmk, sessionId), {
  dmk,
  sessionId,
});

await app.getAddressAndPubKey("m/44'/9000'/0'/0/0", true, "avax"); // X/P chain
await app.signEVMTransaction("m/44'/60'/0'/0/0", rawTxHex); // C chain
```

Any object with a hw-transport-style `send(cla, ins, p1, p2, data?, statusList?)` still
works as the first argument, but the deprecated `@ledgerhq/hw-transport` packages stop
working against Ledger's services in September 2026.

## Notes

Use `yarn install` to avoid issues.

## Release

Push to main branch and a release will be automatic. Release versions are based on commitizen commit messages.
