/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * CSP policy for the Broadcast Box server.
 *
 * NOTE: `baseUrl` in the plugin settings is dynamic, but CSP is registered at
 * main-process startup before plugin settings load. If you change `baseUrl`
 * to a different host, update BROADCAST_BOX_HOST below to match (a client
 * restart is required either way).
 */

import { ConnectSrc, CspPolicies } from "@main/csp";

const BROADCAST_BOX_HOST = "stream.gabrielsouza.top";
CspPolicies[BROADCAST_BOX_HOST] = ConnectSrc;
