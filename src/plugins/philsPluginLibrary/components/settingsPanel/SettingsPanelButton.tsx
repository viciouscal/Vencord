/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { findComponentByCodeLazy } from "@webpack";
import React, { JSX } from "react";

const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

export type IconComponent = <T extends { className: string; }>(props: T) => JSX.Element;
export interface SettingsPanelButtonProps {
    icon?: IconComponent;
    tooltipText?: string;
    onClick?: () => void;
    plated?: boolean;
}

export const SettingsPanelButton = (props: SettingsPanelButtonProps) => {
    return (
        <PanelButton
            tooltipText={props.tooltipText}
            icon={props.icon}
            onClick={props.onClick}
            plated={props.plated}
        />
    );
};
