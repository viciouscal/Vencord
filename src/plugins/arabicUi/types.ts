/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface PluginLocalePack {
    name?: string;
    description?: string;
    settings?: Record<string, string>;
}

export type DiscordLocalePack = Record<string, string>;
