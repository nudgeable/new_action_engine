import { describe, expect, it } from "vitest";
import { whatsappRecapDate } from "../reminder-days";
import {
  buildRecapAllDoneFollowUp,
  buildRecapSomeDoneFollowUp,
  doneButtonPayload,
  parseDonePayload,
  parseRecapPayload,
  recapAllPayload,
  recapSomePayload,
  type ReminderActionState,
  type WhatsAppCompletion,
} from "../whatsapp-action-completion";
import { buildWeeklyRecap, weeklyRecapTemplateName } from "../whatsapp-templates";

const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";
const A3 = "33333333-3333-4333-8333-333333333333";

const saved: WhatsAppCompletion = { outcome: "completed", title: "A", pointsAdded: 10, completedLate: false, surpriseBoxUnlocked: false };
const already: WhatsAppCompletion = { outcome: "already_done", title: "A" };
const blocked: WhatsAppCompletion = { outcome: "unsupported", title: "A" };

function states(doneNumbers: number[] = []): ReminderActionState[] {
  return [A1, A2, A3].map((id, index) => ({
    number: index + 1,
    id,
    title: `Action title ${index + 1}`,
    done: doneNumbers.includes(index + 1),
  }));
}

describe("whatsappRecapDate", () => {
  it("is the Friday itself, and that same Friday on the Saturday catch-up", () => {
    expect(whatsappRecapDate("2026-11-06")).toBe("2026-11-06");
    expect(whatsappRecapDate("2026-11-07")).toBe("2026-11-06");
  });

  it("is null on every other day", () => {
    for (const date of ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]) {
      expect(whatsappRecapDate(date)).toBeNull();
    }
  });

  it("handles a Saturday at the start of a month", () => {
    expect(whatsappRecapDate("2026-08-01")).toBe("2026-07-31");
  });
});

describe("recap payloads", () => {
  it("round-trips All done and Some done", () => {
    expect(parseRecapPayload(recapAllPayload([A1, A2, A3]))).toEqual({ kind: "all", actionIds: [A1, A2, A3] });
    expect(parseRecapPayload(recapSomePayload([A1, A2]))).toEqual({ kind: "some", actionIds: [A1, A2] });
  });

  it("fits Meta's 128-character quick reply payload limit", () => {
    expect(recapAllPayload([A1, A2, A3]).length).toBeLessThanOrEqual(128);
    expect(recapSomePayload([A1, A2, A3]).length).toBeLessThanOrEqual(128);
  });

  it("refuses anything else", () => {
    expect(parseRecapPayload(null)).toBeNull();
    expect(parseRecapPayload("all:")).toBeNull();
    expect(parseRecapPayload("all:not-an-id")).toBeNull();
    expect(parseRecapPayload(doneButtonPayload([A1], 1))).toBeNull();
    const four = `all:${[A1, A2, A3, A1].map((id) => id.replace(/-/g, "")).join(",")}`;
    expect(parseRecapPayload(four)).toBeNull();
  });

  it("isn't mistaken for a Done tap", () => {
    expect(parseDonePayload(recapAllPayload([A1, A2]))).toBeNull();
  });
});

describe("buildWeeklyRecap", () => {
  it("picks the template by action count, capped at three", () => {
    expect([1, 2, 3, 5].map(weeklyRecapTemplateName)).toEqual([
      "plan_recap_1",
      "plan_recap_2",
      "plan_recap_3",
      "plan_recap_3",
    ]);
  });

  it("gives two or three actions All done and Some done buttons", () => {
    const { template, components } = buildWeeklyRecap({
      firstName: "Asha",
      companyName: "Acme Corp",
      actions: [
        { id: A1, title: "Ask an open question" },
        { id: A2, title: "Share credit" },
      ],
    });
    expect(template).toEqual({ name: "plan_recap_2", language: "en" });
    expect(components).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "Asha" },
          { type: "text", text: "Acme Corp" },
          { type: "text", text: "Ask an open question" },
          { type: "text", text: "Share credit" },
        ],
      },
      { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: recapAllPayload([A1, A2]) }] },
      { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: recapSomePayload([A1, A2]) }] },
    ]);
  });

  it("gives a single action the normal Done button, with name and company fallbacks", () => {
    const { template, components } = buildWeeklyRecap({
      firstName: null,
      companyName: null,
      actions: [{ id: A1, title: "A" }],
    });
    expect(template.name).toBe("plan_recap_1");
    expect(components).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "there" },
          { type: "text", text: "Nudgeable" },
          { type: "text", text: "A" },
        ],
      },
      { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: doneButtonPayload([A1], 1) }] },
    ]);
  });

  it("refuses an empty recap", () => {
    expect(() => buildWeeklyRecap({ firstName: null, companyName: null, actions: [] })).toThrow();
  });
});

describe("buildRecapAllDoneFollowUp", () => {
  function body(completions: WhatsAppCompletion[]) {
    const followUp = buildRecapAllDoneFollowUp(completions);
    if (followUp.kind !== "text") throw new Error("expected text");
    return followUp.body;
  }

  it("confirms everything saved", () => {
    const text = body([saved, saved, saved]);
    expect(text).toContain("All 3 actions are marked done");
    expect(text).toContain("Have a good weekend");
  });

  it("counts actions done elsewhere as done", () => {
    expect(body([saved, already])).toContain("All 2 actions are marked done");
  });

  it("says so when a repeat tap saved nothing new", () => {
    expect(body([already, already])).toContain("were already marked done");
  });

  it("mentions late completions", () => {
    expect(body([{ ...saved, completedLate: true } as WhatsAppCompletion, saved])).toContain("completed late");
  });

  it("doesn't celebrate when an action couldn't be updated", () => {
    const text = body([saved, blocked]);
    expect(text).toContain("1 of your 2 actions");
    expect(text).toContain("We couldn't update 1 action");
    expect(text).not.toContain("Well done");
  });
});

describe("buildRecapSomeDoneFollowUp", () => {
  it("lists only open actions, keeping the recap's numbering", () => {
    const followUp = buildRecapSomeDoneFollowUp(states([2]));
    if (followUp.kind !== "interactive") throw new Error("expected interactive");
    const interactive = followUp.interactive as {
      body: { text: string };
      action: { buttons: { reply: { id: string; title: string } }[] };
    };
    expect(interactive.body.text).toContain("Which ones have you completed?");
    expect(interactive.body.text).toContain("1️⃣ Action title 1");
    expect(interactive.body.text).not.toContain("Action title 2");
    expect(interactive.action.buttons.map((button) => button.reply.title)).toEqual(["Action 1 done", "Action 3 done"]);
    expect(parseDonePayload(interactive.action.buttons[1].reply.id)).toEqual({
      number: 3,
      actionId: A3,
      reminderActionIds: [A1, A2, A3],
    });
  });

  it("has nothing to ask once everything is done", () => {
    expect(buildRecapSomeDoneFollowUp(states([1, 2, 3])).kind).toBe("text");
  });
});
