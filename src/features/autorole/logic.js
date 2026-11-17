/**
 * Pure helpers for /autorole (no Discord or database access), so they can be
 * unit-tested offline: list re-numbering, required-role checks, the dropdown
 * role diff, and building the message components for button/dropdown roles.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require("discord.js");
const { UserError } = require("../../core");

/** Component custom-id prefix of this package (see core/components.js). */
const PREFIX = "role";
const MAX_BUTTONS = 25; // 5 rows of 5
const MAX_OPTIONS = 25; // Discord's limit for one select menu
const MAX_REACTIONS = 20; // Discord's limit of different reactions per message
const DEFAULT_PLACEHOLDER = "Pick a role";
const DEFAULT_SCRIPT = '{"embed":{"title":"Pick your roles","description":"Choose from the menu below. Pick a role you already have to remove it."}}';

/** Renumbers items 1..n into `idx`. */
const renumber = (items) => items.map((item, i) => ({ ...item, idx: i + 1 }));

/**
 * Inserts `item` at 1-based `index` (default: the end) and renumbers.
 * Throws a UserError for an index past the end.
 */
function insertAt(items, item, index) {
  const list = [...items].sort((a, b) => a.idx - b.idx);
  const at = index ?? list.length + 1;
  if (at < 1 || at > list.length + 1)
    throw new UserError(`Position must be between 1 and ${list.length + 1}.`);
  list.splice(at - 1, 0, item);
  return renumber(list);
}

/** Removes the item at 1-based `index` and renumbers. Returns { removed, items }. */
function removeAt(items, index) {
  const list = [...items].sort((a, b) => a.idx - b.idx);
  if (!list.length) throw new UserError("There's nothing to remove there.");
  if (index < 1 || index > list.length) throw new UserError(`Position must be between 1 and ${list.length}.`);
  const [removed] = list.splice(index - 1, 1);
  return { removed, items: renumber(list) };
}

/**
 * Required roles: a member needs ANY one of them (an empty set means
 * everyone may use the menu). `hasRole` is (roleId) => boolean.
 */
const meetsRequired = (hasRole, requiredIds) => !requiredIds?.size || [...requiredIds].some((id) => hasRole(id));

/** Validates /autorole dropdownrole limit. Returns { min, max }. */
function checkLimit(min, max) {
  if (!Number.isInteger(min) || !Number.isInteger(max)) throw new UserError("Limits must be whole numbers.");
  if (min < 0 || min > MAX_OPTIONS) throw new UserError(`Minimum must be between 0 and ${MAX_OPTIONS}.`);
  if (max < 1 || max > MAX_OPTIONS) throw new UserError(`Maximum must be between 1 and ${MAX_OPTIONS}.`);
  if (min > max) throw new UserError("Minimum can't be larger than maximum.");
  return { min, max };
}

/**
 * The select menu's min_values / max_values for a menu with `count` options.
 * Stored limits larger than the number of options are clamped, so adding
 * options later "grows into" the limit.
 */
function selectBounds(menu, count) {
  const max = Math.max(1, Math.min(menu.max_values ?? count, count));
  const min = Math.min(menu.min_values ?? 0, max);
  return { min, max };
}

/**
 * What to change when a member submits a dropdown.
 *
 *   menuRoles  every role ID on the menu
 *   held       Set of the member's role IDs
 *   selected   the values they picked
 *   exclusive  true:  the pick REPLACES their roles from this menu
 *                     (picking exactly what they already hold clears it)
 *              false: each picked role is TOGGLED (held -> removed)
 *   max        most roles from this menu a member may hold (null = no cap)
 *
 * Returns { add: [], remove: [] }, or throws a UserError when the result
 * would break the limit. Discord shows a select with nothing pre-selected for
 * everyone, so "toggle" is what lets members add a role without losing the
 * ones they already picked.
 */
function dropdownChanges({ menuRoles, held, selected, exclusive, max = null }) {
  const menu = new Set(menuRoles);
  const picked = new Set(selected.filter((id) => menu.has(id)));
  const current = new Set([...menu].filter((id) => held.has(id)));

  let target;
  if (exclusive) {
    const same = picked.size === current.size && [...picked].every((id) => current.has(id));
    target = same ? new Set() : picked;
  } else {
    target = new Set(current);
    for (const id of picked) (target.has(id) ? target.delete(id) : target.add(id));
  }

  if (max != null && target.size > max)
    throw new UserError(`You can only have ${max} role${max === 1 ? "" : "s"} from this menu. Pick one you have to remove it first.`);

  return {
    add: [...target].filter((id) => !current.has(id)),
    remove: [...current].filter((id) => !target.has(id)),
  };
}

/** True for an action row (JSON or discord.js object) holding one of our components. */
const isOurRow = (row) => (row.components ?? []).some((c) => String(c.customId ?? c.custom_id ?? "").startsWith(`${PREFIX}:`));

/** A button's style name for lists. */
const STYLE_NAMES = { [ButtonStyle.Primary]: "Blurple", [ButtonStyle.Secondary]: "Grey", [ButtonStyle.Success]: "Green", [ButtonStyle.Danger]: "Red" };

/**
 * Builds the message's action rows: dropdown first, then our buttons (5 per
 * row), then any rows that belong to something else (kept untouched).
 *   menu     dropdown menu with .options, or null
 *   buttons  button rows sorted by idx
 *   foreign  rows already on the message that aren't ours (JSON or objects)
 * Throws a UserError if that adds up to more than Discord's 5 rows.
 */
function buildRows({ menu = null, buttons = [], foreign = [] }) {
  const rows = [];
  if (menu?.options?.length) {
    const { min, max } = selectBounds(menu, menu.options.length);
    const select = new StringSelectMenuBuilder()
      .setCustomId(`${PREFIX}:d`)
      .setPlaceholder((menu.placeholder || DEFAULT_PLACEHOLDER).slice(0, 150))
      .setMinValues(min)
      .setMaxValues(max)
      .addOptions(
        menu.options.map((o) => {
          const option = { label: o.title.slice(0, 100), value: o.role_id };
          if (o.description) option.description = o.description.slice(0, 100);
          if (o.emoji) option.emoji = o.emoji;
          return option;
        })
      );
    rows.push(new ActionRowBuilder().addComponents(select));
  }
  for (let i = 0; i < buttons.length; i += 5)
    rows.push(
      new ActionRowBuilder().addComponents(
        buttons.slice(i, i + 5).map((b) => {
          const button = new ButtonBuilder().setCustomId(`${PREFIX}:b:${b.role_id}`).setStyle(b.style ?? ButtonStyle.Primary);
          if (b.label) button.setLabel(b.label.slice(0, 80));
          if (b.emoji) button.setEmoji(b.emoji);
          return button;
        })
      )
    );
  for (const row of foreign) rows.push(row.toJSON ? row : ActionRowBuilder.from(row));
  if (rows.length > 5)
    throw new UserError("That message would need more than 5 rows of buttons/menus. Remove some first.");
  return rows;
}

module.exports = {
  PREFIX,
  MAX_BUTTONS,
  MAX_OPTIONS,
  MAX_REACTIONS,
  DEFAULT_PLACEHOLDER,
  DEFAULT_SCRIPT,
  STYLE_NAMES,
  renumber,
  insertAt,
  removeAt,
  meetsRequired,
  checkLimit,
  selectBounds,
  dropdownChanges,
  isOurRow,
  buildRows,
};
