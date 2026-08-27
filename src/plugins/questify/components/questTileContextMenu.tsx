/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addIgnoredQuest, questIsIgnored, removeIgnoredQuest } from "@plugins/questify/settings/ignoredQuests";
import { rerenderQuests } from "@plugins/questify/settings/rerender";
import { canAutoCompleteQuest, getQuestAutoCompleteEntry, processQuestForAutoComplete, stopQuestAutoComplete } from "@plugins/questify/utils/completion";
import type { Quest } from "@plugins/questify/utils/types";
import { q } from "@plugins/questify/utils/ui";
import { copyToClipboard } from "@utils/index";
import { Menu } from "@webpack/common";
import type { ReactNode } from "react";

export function QuestTileContextMenu(
    children: ReactNode[],
    props: { quest?: Quest; },
    isClaimedMenu: boolean = false,
): void {
    const { quest } = props;

    if (!quest) {
        return;
    }

    const isIgnored = questIsIgnored(quest.id);
    const isEnrolled = Boolean(quest.userStatus?.enrolledAt);
    const isAutoCompleting = getQuestAutoCompleteEntry(quest) != null;
    const canStartAutoComplete = !isClaimedMenu && isEnrolled && canAutoCompleteQuest(quest);

    children.unshift((
        <Menu.MenuGroup>
            {!isClaimedMenu && (!isIgnored ? (
                <Menu.MenuItem
                    id={q("ignore-quest")}
                    label="Mark as Ignored"
                    action={() => addIgnoredQuest(quest.id)}
                />
            ) : (
                <Menu.MenuItem
                    id={q("unignore-quest")}
                    label="Unmark as Ignored"
                    action={() => removeIgnoredQuest(quest.id)}
                />
            ))}
            {isAutoCompleting ? (
                <Menu.MenuItem
                    id={q("stop-auto-complete")}
                    label="Stop Auto-Complete"
                    action={() => {
                        stopQuestAutoComplete(quest, {
                            manual: true,
                            preserveResume: false,
                            terminalHeartbeat: true,
                        });
                        rerenderQuests();
                    }}
                />
            ) : canStartAutoComplete ? (
                <Menu.MenuItem
                    id={q("start-auto-complete")}
                    label="Start Auto-Complete"
                    action={() => {
                        processQuestForAutoComplete(quest, {
                            force: true,
                            source: "manual",
                        });
                        rerenderQuests();
                    }}
                />
            ) : null}
            <Menu.MenuItem
                id={q("copy-quest-id")}
                label="Copy Quest ID"
                action={() => copyToClipboard(quest.id)}
            />
        </Menu.MenuGroup>
    ));
}
