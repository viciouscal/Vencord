/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "plugins/_misc/styles.css";

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Forms, UserStore } from "@webpack/common";

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
        ]
    }
});

export default definePlugin({
    name: "PlatformSpoofer",
    description: "Spoof what platform or device you're on",
    authors: [Devs.Drag, Devs.viciouscal],
    settings: settings,
    patches: [
        {
            find: "_doIdentify(){",
            replacement: {
                match: /(\[IDENTIFY\].*let.{0,5}=\{.*properties:)(.*),presence/,
                replace: "$1{...$2,...$self.getPlatform(true)},presence"
            }
        },
        {
            find: "#{intl::POPOUT_STAY_ON_TOP}),icon:",
            replacement: {
                match: /(?<=CallTile.{0,15}\.memo\((\i)=>\{)/,
                replace: "$1.platform = $self.getPlatform(false, $1?.participantUserId)?.vcIcon || $1?.platform;"
            }
        },
        {
            find: '("AppSkeleton");',
            replacement: {
                match: /(?<=\.isPlatformEmbedded.{0,50}\i\)\)\}.{0,30})\i\?\i\.\i\.set\(.{0,10}:/,
                replace: ""
            }
        }
    ],
    getPlatform(bypass, userId?: any) {
        const platform = settings.store.platform ?? "desktop";

        if (bypass || userId === UserStore.getCurrentUser().id) {
            switch (platform) {
                case "desktop":
                    return { browser: "Discord Client", vcIcon: 0 };
                case "web":
                    return { browser: "Chrome", vcIcon: 0 };
                case "mobile":
                    return { browser: "Discord iOS", vcIcon: 1 };
                case "embedded":
                    return { browser: "Discord Embedded" };
            }
        }

        return null;
    }
});
