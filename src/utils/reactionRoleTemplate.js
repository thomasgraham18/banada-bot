/**
 * Starter content for the reaction-role board: one colour group and one
 * role-icon group. Everything here can be edited in the web panel.
 *
 * Options without an emoji are skipped when publishing; pick a server emoji
 * for them in the panel (flags of provinces etc. do not exist in Unicode).
 */
const C = {
  red: "#E74C3C",
  orange: "#E67E22",
  yellow: "#F1C40F",
  green: "#2ECC71",
  cyan: "#5DD9F0",
  blue: "#3498DB",
  violet: "#9B59B6",
  pink: "#F78FB3",
  brown: "#A0522D",
  white: "#FFFFFF",
  // Pure black (#000000) means "no colour" to Discord.
  black: "#111214",
};

const NOTE_COLOUR =
  "Gradients need the Enhanced Role Styles server boost perk; without it the first colour is used.";
const NOTE_ICON = "Role icons need the Level 2 server boost perk.";

const colour = (code, label, emoji, a, b) => ({
  code,
  label,
  emoji,
  colour: a,
  colour2: b ?? "",
});
const icon = (code, label, emoji = "") => ({ code, label, emoji });

module.exports = () => [
  {
    name: "Colours",
    kind: "colour",
    rolePrefix: "Colour",
    exclusive: true,
    requiredRoleIds: [],
    header:
      "💎 __**Colour Role Selection**__\n" +
      "These role menus contain optional vanity roles that colour your server profile's display colour.\n" +
      "React with the provided emoji to select your server profile's display colour:",
    menus: [
      {
        title: "Colour Palette 01: Standard",
        description: "This palette contains a selection of basic colours.",
        note: "",
        options: [
          colour("1.01", "Red", "❤️", C.red),
          colour("1.02", "Orange", "🧡", C.orange),
          colour("1.03", "Yellow", "💛", C.yellow),
          colour("1.04", "Green", "💚", C.green),
          colour("1.05", "Cyan", "🩵", C.cyan),
          colour("1.06", "Blue", "💙", C.blue),
          colour("1.07", "Violet", "💜", C.violet),
          colour("1.08", "Pink", "🩷", C.pink),
          colour("1.09", "Brown", "🤎", C.brown),
          colour("1.10", "White", "🤍", C.white),
          colour("1.11", "Black", "🖤", C.black),
          { ...colour("1.12", "Holographic", "🩶", "#A9C9FF"), holo: true },
        ],
      },
      {
        title: "Colour Palette 02: Gradients",
        description: "This palette contains a selection of colour gradients.",
        note: NOTE_COLOUR,
        options: [
          colour("2.01", "Red -> Orange", "🍁", C.red, C.orange),
          colour("2.02", "Orange -> Yellow", "🏵️", C.orange, C.yellow),
          colour("2.03", "Yellow -> Green", "🌾", C.yellow, C.green),
          colour("2.04", "Green -> Cyan", "🛶", C.green, C.cyan),
          colour("2.05", "Cyan -> Blue", "🌊", C.cyan, C.blue),
          colour("2.06", "Blue -> Violet", "🪻", C.blue, C.violet),
          colour("2.07", "Violet -> Pink", "⚜️", C.violet, C.pink),
          colour("2.08", "Pink -> Red", "🌷", C.pink, C.red),
          colour("2.09", "Red -> Green", "🎄", C.red, C.green),
          colour("2.10", "Orange -> Blue", "🌅", C.orange, C.blue),
          colour("2.11", "Yellow -> Violet", "🐥", C.yellow, C.violet),
          colour("2.12", "Cyan -> Pink", "🍧", C.cyan, C.pink),
          colour("2.13", "White -> Black", "🏁", C.white, C.black),
        ],
      },
    ],
  },
  {
    name: "Role icons",
    kind: "icon",
    rolePrefix: "Icon",
    exclusive: true,
    requiredRoleIds: [],
    header:
      "🏵️ __**Role Icon Selection**__\n" +
      "These role menus contain optional vanity roles that change your server profile's role icon (the icon next to your name).\n" +
      "React with the provided emoji to select your server profile's role icon:",
    menus: [
      {
        title: "Icon Selection 01: Flags",
        description: "This menu contains a selection of role icons; *national, provincial and territorial flags.*",
        note: NOTE_ICON,
        options: [
          icon("1.01", "Canada", "🇨🇦"),
          icon("1.02", "Alberta"),
          icon("1.03", "British Columbia"),
          icon("1.04", "Manitoba"),
          icon("1.05", "New Brunswick"),
          icon("1.06", "Newfoundland and Labrador"),
          icon("1.07", "Nova Scotia"),
          icon("1.08", "Ontario"),
          icon("1.09", "Prince Edward Island"),
          icon("1.10", "Quebec"),
          icon("1.11", "Saskatchewan"),
          icon("1.12", "Northwest Territories"),
          icon("1.13", "Nunavut"),
          icon("1.14", "Yukon"),
        ],
      },
      {
        title: "Icon Selection 02: Symbols",
        description: "This menu contains a selection of role icons; *other symbols.*",
        note: NOTE_ICON,
        options: [
          icon("2.01", "Cross", "✝️"),
          icon("2.02", "Fleur-de-lis", "⚜️"),
          icon("2.03", "Maple Leaf", "🍁"),
          icon("2.04", "Poppy", "🌺"),
        ],
      },
    ],
  },
];
