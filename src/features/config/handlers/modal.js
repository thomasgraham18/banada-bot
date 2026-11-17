/**
 * A small modal prompt for the few /config forms that aren't a plain script
 * (nickname picker, webhook username/avatar + message).
 *
 * The custom ID uses our "cfg" prefix but no persistent handler is
 * registered for it, so core/components ignores it and only this
 * awaitModalSubmit() collector receives the submission.
 */
const { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");

/**
 * @param interaction a command interaction that has NOT been replied to (defer: false)
 * @param {{ title: string, fields: { id, label, value?, placeholder?, paragraph?, required?, max? }[] }} form
 * @returns {Promise<{ submit, values: Record<string,string> } | null>} null if closed / timed out
 */
async function askModal(interaction, { title, fields, time = 600_000 }) {
  const customId = `cfg:form:${interaction.id}`;
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title.slice(0, 45));
  for (const f of fields) {
    const input = new TextInputBuilder()
      .setCustomId(f.id)
      .setLabel(f.label.slice(0, 45))
      .setStyle(f.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(Boolean(f.required))
      .setMaxLength(f.max ?? (f.paragraph ? 4000 : 100));
    if (f.value) input.setValue(String(f.value).slice(0, f.max ?? 4000));
    if (f.placeholder) input.setPlaceholder(f.placeholder.slice(0, 100));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  await interaction.showModal(modal);
  const submit = await interaction
    .awaitModalSubmit({ time, filter: (m) => m.customId === customId && m.user.id === interaction.user.id })
    .catch(() => null);
  if (!submit) return null;
  const values = {};
  for (const f of fields) values[f.id] = submit.fields.getTextInputValue(f.id)?.trim() ?? "";
  return { submit, values };
}

module.exports = { askModal };
