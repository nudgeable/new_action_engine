import { describe, expect, it } from "vitest";
import { doneButtonPayload } from "../whatsapp-action-completion";
import {
  actionLines,
  actionReminderTemplateName,
  buildActionReminder,
  sanitizeTemplateParam,
} from "../whatsapp-templates";

const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";

describe("sanitizeTemplateParam", () => {
  it("removes characters WhatsApp rejects in template parameters", () => {
    expect(sanitizeTemplateParam("Line one\nLine\ttwo    spaced", 100)).toBe("Line one Line two spaced");
  });

  it("truncates with an ellipsis", () => {
    expect(sanitizeTemplateParam("abcdefghij", 5)).toBe("abcd…");
    expect(sanitizeTemplateParam("abc", 5)).toBe("abc");
  });
});

describe("actionReminderTemplateName", () => {
  it("picks the template with one line per action, capped at three", () => {
    expect(actionReminderTemplateName(1)).toBe("plan_reminder_1");
    expect(actionReminderTemplateName(2)).toBe("plan_reminder_2");
    expect(actionReminderTemplateName(3)).toBe("plan_reminder_3");
    expect(actionReminderTemplateName(5)).toBe("plan_reminder_3");
    expect(actionReminderTemplateName(2, true)).toBe("plan_reminder_img_2");
  });
});

describe("actionLines", () => {
  it("gives one parameter per action", () => {
    expect(actionLines(["Ask an open question", "Share credit"])).toEqual(["Ask an open question", "Share credit"]);
  });

  it("folds any extra actions into the third line", () => {
    const titles = Array.from({ length: 5 }, (_, i) => `Action ${i + 1}`);
    expect(actionLines(titles)).toEqual(["Action 1", "Action 2", "Action 3 (+2 more)"]);
  });

  it("keeps every line within the length cap", () => {
    const lines = actionLines(Array.from({ length: 8 }, () => "x".repeat(500)));
    expect(lines.every((line) => line.length <= 120)).toBe(true);
  });
});

describe("buildActionReminder", () => {
  it("fills name, company, action lines and a Done button per action, with no header", () => {
    expect(
      buildActionReminder({
        firstName: "Asha",
        companyName: "Acme Corp",
        track: "weekly",
        actions: [
          { id: A1, title: "Ask an open question" },
          { id: A2, title: "Share credit" },
        ],
      })
    ).toEqual({
      template: { name: "plan_reminder_2", language: "en" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: "Asha" },
            { type: "text", text: "Acme Corp" },
            { type: "text", text: "this week" },
            { type: "text", text: "Ask an open question" },
            { type: "text", text: "Share credit" },
          ],
        },
        { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: doneButtonPayload([A1, A2], 1) }] },
        { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: doneButtonPayload([A1, A2], 2) }] },
      ],
    });
  });

  it("uses the image variant with the first action's picture as the header", () => {
    const img = "https://x.supabase.co/storage/v1/object/public/action-images/library/a.png";
    const { template, components } = buildActionReminder({
      firstName: "Asha",
      companyName: "Acme",
      track: "weekly",
      withImage: true,
      actions: [
        { id: A1, title: "A", imageUrl: img },
        { id: A2, title: "B", imageUrl: null },
      ],
    });
    expect(template.name).toBe("plan_reminder_img_2");
    expect(components[0]).toEqual({ type: "header", parameters: [{ type: "image", image: { link: img } }] });
    expect(components[1].type).toBe("body");
  });

  it("stays on the plain template when images are off or the first action has none", () => {
    const actions = [{ id: A1, title: "A", imageUrl: "https://x.co/a.png" }];
    expect(buildActionReminder({ firstName: null, companyName: null, track: "daily", actions }).template.name).toBe(
      "plan_reminder_1"
    );
    const noImage = buildActionReminder({
      firstName: null,
      companyName: null,
      track: "daily",
      withImage: true,
      actions: [{ id: A1, title: "A", imageUrl: "http://insecure/a.png" }],
    });
    expect(noImage.template.name).toBe("plan_reminder_1");
    expect(noImage.components.some((c) => c.type === "header")).toBe(false);
  });

  it("falls back for a missing name and company, and says 'today' for daily plans", () => {
    const { template, components } = buildActionReminder({
      firstName: null,
      companyName: null,
      track: "daily",
      actions: [{ id: A1, title: "A" }],
    });
    expect(template.name).toBe("plan_reminder_1");
    expect(components[0]).toEqual({
      type: "body",
      parameters: [
        { type: "text", text: "there" },
        { type: "text", text: "Nudgeable" },
        { type: "text", text: "today" },
        { type: "text", text: "A" },
      ],
    });
    expect(components.slice(1).map((c) => (c.type === "button" ? c.sub_type : c.type))).toEqual(["quick_reply"]);
  });

  it("gives Done buttons to the first three actions only", () => {
    const actions = Array.from({ length: 5 }, (_, i) => ({ id: `${i}${A1.slice(1)}`, title: `Action ${i + 1}` }));
    const { template, components } = buildActionReminder({
      firstName: null,
      companyName: null,
      track: "weekly",
      actions,
    });
    expect(template.name).toBe("plan_reminder_3");
    expect(components.filter((c) => c.type === "button")).toHaveLength(3);
  });

  it("refuses an empty reminder", () => {
    expect(() =>
      buildActionReminder({ firstName: null, companyName: null, track: "weekly", actions: [] })
    ).toThrow();
  });
});
