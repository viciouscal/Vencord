/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings, useSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import { LazyComponent } from "@utils/lazyReact";
import { classes } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { filters, find, findByPropsLazy, findStoreLazy } from "@webpack";
import {
    ChannelStore,
    Menu,
    PermissionsBits,
    PermissionStore,
    React,
    SelectedChannelStore,
    Toasts,
    UserStore
} from "@webpack/common";
import type { Channel, User } from "@vencord/discord-types";
import type { PropsWithChildren, SVGProps } from "react";

const HeaderBarIcon = LazyComponent(() => {
    const filter = filters.byCode(".HEADER_BAR_BADGE");
    return find(m => m.Icon && filter(m.Icon)).Icon;
});

interface BaseIconProps extends IconProps {
    viewBox: string;
}

interface IconProps extends SVGProps<SVGSVGElement> {
    className?: string;
    height?: string | number;
    width?: string | number;
}

function Icon({
    height = 24,
    width = 24,
    className,
    children,
    viewBox,
    ...svgProps
}: PropsWithChildren<BaseIconProps>) {
    return (
        <svg
            className={classes(className, "vc-icon")}
            role="img"
            width={width}
            height={height}
            viewBox={viewBox}
            {...svgProps}
        >
            {children}
        </svg>
    );
}

function FollowIcon(props: IconProps) {
    return (
        <Icon
            {...props}
            className={classes(props.className, "vc-follow-icon")}
            viewBox="0 -960 960 960"
        >
            <path
                fill="currentColor"
                d="m480-120-58-52q-101-91-167-157T150-447.5Q111-500 95.5-544T80-634q0-94 63-157t157-63q52 0 99 22t81 62q34-40 81-62t99-22q94 0 157 63t63 157q0 46-15.5 90T810-447.5Q771-395 705-329T538-172l-58 52Zm0-108q96-86 158-147.5t98-107q36-45.5 50-81t14-70.5q0-60-40-100t-100-40q-47 0-87 26.5T518-680h-76q-15-41-55-67.5T300-774q-60 0-100 40t-40 100q0 35 14 70.5t50 81q36 45.5 98 107T480-228Zm0-273Z"
            />
        </Icon>
    );
}

function UnfollowIcon(props: IconProps) {
    return (
        <Icon
            {...props}
            className={classes(props.className, "vc-unfollow-icon")}
            viewBox="0 -960 960 960"
        >
            <path
                fill="currentColor"
                d="m480-120-58-52q-101-91-167-157T150-447.5Q111-500 95.5-544T80-634q0-94 63-157t157-63q52 0 99 22t81 62q34-40 81-62t99-22q94 0 157 63t63 157q0 46-15.5 90T810-447.5Q771-395 705-329T538-172l-58 52Z"
            />
        </Icon>
    );
}

interface VoiceState {
    userId: string;
    channelId?: string;
    oldChannelId?: string;
    deaf: boolean;
    mute: boolean;
    selfDeaf: boolean;
    selfMute: boolean;
    selfStream: boolean;
    selfVideo: boolean;
    sessionId: string;
    suppress: boolean;
    requestToSpeakTimestamp: string | null;
}

function getFollowedIds(): string[] {
    try {
        const raw = settings.store.followUserIds;
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch {
        return [];
    }
}

function setFollowedIds(ids: string[]) {
    settings.store.followUserIds = JSON.stringify(ids);
}

const MAX_FOLLOWED = 2;

export const settings = definePluginSettings({
    executeOnFollow: {
        type: OptionType.BOOLEAN,
        description: "Make sure to be in the same VC when following a user",
        restartNeeded: false,
        default: true
    },
    onlyManualTrigger: {
        type: OptionType.BOOLEAN,
        description: "Only trigger on indicator click",
        restartNeeded: false,
        default: false
    },
    followLeave: {
        type: OptionType.BOOLEAN,
        description: "Also leave when the followed user leaves",
        restartNeeded: false,
        default: false
    },
    autoMoveBack: {
        type: OptionType.BOOLEAN,
        description: "Automatically move back to the VC of the followed user when you got moved",
        restartNeeded: false,
        default: false
    },
    autoRejoin: {
        type: OptionType.BOOLEAN,
        description: "Automatically rejoin the VC of the followed user when you disconnect",
        restartNeeded: false,
        default: false
    },
    followUserIds: {
        type: OptionType.STRING,
        description: "Followed User IDs (JSON array, managed via context menu)",
        restartNeeded: false,
        hidden: true,
        default: "[]",
    },
    channelFull: {
        type: OptionType.BOOLEAN,
        description: "Attempt to move you to the channel when is not full anymore",
        restartNeeded: false,
        default: true,
    }
});

const ChannelActions: {
    disconnect: () => void;
    selectVoiceChannel: (channelId: string) => void;
} = findByPropsLazy("disconnect", "selectVoiceChannel");

const VoiceStateStore: VoiceStateStore = findStoreLazy("VoiceStateStore");
const CONNECT = 1n << 20n;

interface VoiceStateStore {
    getAllVoiceStates(): VoiceStateEntry;
    getVoiceStatesForChannel(channelId: string): VoiceStateMember;
}

interface VoiceStateEntry {
    [guildIdOrMe: string]: VoiceStateMember;
}

interface VoiceStateMember {
    [userId: string]: VoiceState;
}

function getChannelId(userId: string) {
    if (!userId) return null;
    try {
        const states = VoiceStateStore.getAllVoiceStates();
        for (const users of Object.values(states)) {
            if (users[userId]) return users[userId].channelId ?? null;
        }
    } catch (e) { }
    return null;
}

function triggerFollow(
    userId: string,
    userChannelId: string | null = getChannelId(userId)
) {
    const myChanId = SelectedChannelStore.getVoiceChannelId();
    const username = UserStore.getUser(userId)?.username ?? userId;

    if (userChannelId) {
        if (userChannelId !== myChanId) {
            const channel = ChannelStore.getChannel(userChannelId);
            const voiceStates = VoiceStateStore.getVoiceStatesForChannel(userChannelId);
            const memberCount = voiceStates ? Object.keys(voiceStates).length : null;
            if (channel.type === 1 || PermissionStore.can(CONNECT, channel)) {
                if (
                    channel.userLimit !== 0 &&
                    memberCount !== null &&
                    memberCount >= channel.userLimit &&
                    !PermissionStore.can(PermissionsBits.MOVE_MEMBERS, channel)
                ) {
                    Toasts.show({
                        message: `Channel is full (following ${username})`,
                        id: Toasts.genId(),
                        type: Toasts.Type.FAILURE
                    });
                    return;
                }
                ChannelActions.selectVoiceChannel(userChannelId);
                Toasts.show({
                    message: `Followed ${username} into a new voice channel`,
                    id: Toasts.genId(),
                    type: Toasts.Type.SUCCESS
                });
            } else {
                Toasts.show({
                    message: `Insufficient permissions to enter ${username}'s voice channel`,
                    id: Toasts.genId(),
                    type: Toasts.Type.FAILURE
                });
            }
        } else {
            Toasts.show({
                message: `You are already in the same channel as ${username}`,
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE
            });
        }
    } else if (myChanId) {
        if (settings.store.followLeave) {
            ChannelActions.disconnect();
            Toasts.show({
                message: `${username} left, disconnected`,
                id: Toasts.genId(),
                type: Toasts.Type.SUCCESS
            });
        } else {
            Toasts.show({
                message: `${username} left, but not following disconnect`,
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE
            });
        }
    } else {
        Toasts.show({
            message: `${username} is not in a voice channel`,
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE
        });
    }
}

function triggerFollowAll() {
    for (const uid of getFollowedIds()) {
        triggerFollow(uid);
    }
}

function toggleFollow(userId: string) {
    const ids = getFollowedIds();
    if (ids.includes(userId)) {
        setFollowedIds(ids.filter(id => id !== userId));
        const username = UserStore.getUser(userId)?.username ?? userId;
        Toasts.show({
            message: `Unfollowed ${username}`,
            id: Toasts.genId(),
            type: Toasts.Type.SUCCESS
        });
    } else {
        if (ids.length >= MAX_FOLLOWED) {
            Toasts.show({
                message: `You can only follow up to ${MAX_FOLLOWED} users at once`,
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE
            });
            return;
        }
        setFollowedIds([...ids, userId]);
        if (settings.store.executeOnFollow) {
            triggerFollow(userId);
        }
    }
}

interface UserContextProps {
    channel: Channel;
    guildId?: string;
    user: User;
}

const UserContext: NavContextMenuPatchCallback = (children, { user }: UserContextProps) => {
    if (!user || user.id === UserStore.getCurrentUser().id) return;
    const ids = getFollowedIds();
    const isFollowed = ids.includes(user.id);

    const atLimit = !isFollowed && ids.length >= MAX_FOLLOWED;
    const label = isFollowed ? "Unfollow User" : atLimit ? `Follow User (max ${MAX_FOLLOWED})` : "Follow User";
    const icon = isFollowed ? UnfollowIcon : FollowIcon;

    children.splice(-1, 0, (
        <Menu.MenuGroup>
            <Menu.MenuItem
                id="follow-user"
                label={label}
                action={() => !atLimit && toggleFollow(user.id)}
                icon={icon}
                disabled={atLimit}
            />
            {ids.length >= 2 && (
                <Menu.MenuItem
                    id="unfollow-all-users"
                    label="Unfollow All"
                    action={() => {
                        setFollowedIds([]);
                        Toasts.show({
                            message: "Unfollowed all users",
                            id: Toasts.genId(),
                            type: Toasts.Type.SUCCESS
                        });
                    }}
                    icon={UnfollowIcon}
                />
            )}
        </Menu.MenuGroup>
    ));
};

export default definePlugin({
    name: "FollowUser",
    description: "Adds a follow option in the user context menu to always be in the same VC as them (supports up to 2 users)",
    authors: [Devs.D3SOX,Devs.Phzzy],

    settings,

    patches: [
        {
            find: "toolbar:function",
            replacement: {
                match: /(function \i\(\i\){)(.{1,200}toolbar.{1,100}mobileToolbar)/,
                replace: "$1$self.addIconToToolBar(arguments[0]);$2"
            }
        },
    ],

    contextMenus: {
        "user-context": UserContext
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            if (settings.store.onlyManualTrigger) return;

            const followedIds = getFollowedIds();
            if (!followedIds.length) return;

            for (const { userId, channelId, oldChannelId } of voiceStates) {
                if (channelId === oldChannelId) continue;

                const isMe = userId === UserStore.getCurrentUser().id;

                if (settings.store.autoMoveBack && isMe && channelId && oldChannelId) {
                    triggerFollowAll();
                    continue;
                }

                if (settings.store.autoRejoin && isMe && !channelId && oldChannelId) {
                    triggerFollowAll();
                    continue;
                }

                if (
                    settings.store.channelFull &&
                    !isMe &&
                    !channelId &&
                    oldChannelId &&
                    oldChannelId !== SelectedChannelStore.getVoiceChannelId()
                ) {
                    const channel = ChannelStore.getChannel(oldChannelId);
                    const channelVoiceStates = VoiceStateStore.getVoiceStatesForChannel(oldChannelId);
                    const memberCount = channelVoiceStates ? Object.keys(channelVoiceStates).length : null;
                    if (
                        channel.userLimit !== 0 &&
                        memberCount !== null &&
                        memberCount === channel.userLimit - 1 &&
                        !PermissionStore.can(PermissionsBits.MOVE_MEMBERS, channel)
                    ) {
                        const usersInChannel = Object.values(channelVoiceStates).map(x => x.userId);
                        if (followedIds.some(fid => usersInChannel.includes(fid))) {
                            const targetId = followedIds.find(fid => usersInChannel.includes(fid))!;
                            triggerFollow(targetId, oldChannelId);
                            continue;
                        }
                    }
                }

                const isFollowed = followedIds.includes(userId);
                if (!isFollowed) continue;

                if (channelId) {
                    triggerFollow(userId, channelId);
                } else if (oldChannelId) {
                    triggerFollow(userId, null);
                }
            }
        },
    },

    FollowIndicator() {
        const { plugins: { FollowUser: { followUserIds } } } = useSettings(["plugins.FollowUser.followUserIds"]);

        let ids: string[] = [];
        try { ids = JSON.parse(followUserIds ?? "[]"); } catch { }

        if (!ids.length) return null;

        const names = ids.map(id => UserStore.getUser(id)?.username ?? id).join(" & ");

        return (
            <HeaderBarIcon
                tooltip={`Following ${names} (click to trigger manually, right-click to unfollow all)`}
                icon={UnfollowIcon}
                onClick={() => triggerFollowAll()}
                onContextMenu={() => setFollowedIds([])}
            />
        );
    },

    addIconToToolBar(e: { toolbar: React.ReactNode[] | React.ReactNode; }) {
        if (Array.isArray(e.toolbar)) {
            return e.toolbar.push(
                <ErrorBoundary noop={true} key="follow-indicator">
                    <this.FollowIndicator />
                </ErrorBoundary>
            );
        }
        e.toolbar = [
            <ErrorBoundary noop={true} key="follow-indicator">
                <this.FollowIndicator />
            </ErrorBoundary>,
            e.toolbar,
        ];
    },
});