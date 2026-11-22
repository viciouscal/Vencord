/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";

const settings = definePluginSettings({
    platform: {
        type: OptionType.SELECT,
        description: "What platform to show up as on",
        restartNeeded: true,
        options: [
            {
                label: "Desktop",
                value: "desktop",
                default: true,
            },
            {
                label: "Web",
                value: "web",
            },
            {
                label: "Mobile",
                value: "mobile",
            },
            {
                label: "Console",
                value: "embedded",
            },
            {
                label: "VR",
                value: "vr",
            },
        ],
    },
});

export default definePlugin({
    name: "PlatformSpoofer",
    description: "Spoof what platform or device you're on",
    authors: [Devs.Drag, Devs.neoarz, Devs.viciouscal],
    settings,
    patches: [
        {
            find: "_doIdentify(){",
            replacement: [
                {
                    match: /window._ws=null,null!=\i/,
                    replace: "false",
                },
                {
                    match: /properties:(\i),presence:(\i),compress:this\.compressionHandler\.usesLegacyCompression\(\)/,
                    replace: "properties:{...$1,...$self.getPlatform(true)},presence:$2,compress:this.compressionHandler.usesLegacyCompression()",
                },
            ],
        },
    ],
    getPlatform(bypass, userId?: unknown) {
        const platform = settings.store.platform ?? "desktop";

        if (bypass) {
            switch (platform) {
                case "desktop":
                    return { browser: "Discord Client" };
                case "web":
                    return { browser: "Discord Web" };
                case "mobile":
                    return { browser: "Discord iOS" };
                case "embedded":
                    return { browser: "Discord Embedded" };
                case "vr":
                    return { browser: "Discord VR" };
                default:
                    return null;
            }
        }

        return null;
    },
});
