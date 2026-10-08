/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "@plugins/questify/settings.css";

import { setSettingsSearchQuery, useSettingsSearchMatchCount, useSettingsSearchQuery } from "@plugins/questify/settings/search";
import { q } from "@plugins/questify/utils/ui";
import { TextInput, useEffect, useState } from "@webpack/common";
import type { JSX } from "react";

export function SettingsSearch(): JSX.Element {
    const query = useSettingsSearchQuery();
    const matchCount = useSettingsSearchMatchCount();
    const [inputValue, setInputValue] = useState(query);

    useEffect(() => {
        if (!inputValue.trim()) {
            setSettingsSearchQuery("");
            return;
        }

        const timeout = setTimeout(() => setSettingsSearchQuery(inputValue), 250);

        return () => clearTimeout(timeout);
    }, [inputValue]);

    useEffect(() => () => setSettingsSearchQuery(""), []);

    return (
        <div className={q("settings-search")}>
            <TextInput
                type="search"
                aria-label="Search Questify Settings"
                placeholder="Search Questify Settings..."
                value={inputValue}
                onChange={setInputValue}
            />
            {query.trim() && matchCount === 0 && (
                <div className={q("settings-search-empty")} role="status">No matching settings.</div>
            )}
        </div>
    );
}
