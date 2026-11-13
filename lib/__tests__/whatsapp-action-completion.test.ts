import { describe, expect, it } from "vitest";
import {
  buildCompletionFollowUp,
  doneButtonPayload,
  parseDonePayload,
  type ReminderActionState,
} from "../whatsapp-action-completion";

const IDS = [1, 2, 3].map((n) => `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-11111111111${n}`);

function states(doneNumbers: number[]): ReminderActionState[] {
  return IDS.map((id, index) => ({ number: index + 1, id, title: `Action ${index + 1}`, done: doneNumbers.includes(index + 1) }));
}

const completed = (title: string) => ({
  outcome: "completed" as const,
  title,
  pointsAdded: 50,
  completedLate: false,
  surpriseBoxUnlocked: false,
});

type Buttons = { type: string; body: { text: string }; action: { buttons: { reply: { id: string; title: string } }[] } };

describe("Done payloads", () => {
  it("round-trips the tapped number and the whole reminder", () => {
    const payload = doneButtonPayload(IDS, 2);
    expect(payload.length).toBeLessThanOrEqual(256);
    expect(parseDonePayload(payload)).toEqual({ number: 2, actionId: IDS[1], reminderActionIds: IDS });
  });

  it("rejects anything malformed", () => {
    expect(parseDonePayload(null)).toBeNull();
    expect(parseDonePayload("skip")).toBeNull();
    expect(parseDonePayload("done:1:not-an-id")).toBeNull();
    expect(parseDonePayload(doneButtonPayload(IDS, 2).replace("done:2", "done:4"))).toBeNull();
    expect(parseDonePayload(`${doneButtonPayload(IDS, 1)}:extra`)).toBeNull();
  });
});

describe("buildCompletionFollowUp", () => {
  it("after Action 2 done: confirms it and offers buttons for actions 1 and 3", () => {
    const message = buildCompletionFollowUp({ completion: completed("Action 2"), tappedNumber: 2, actions: states([2]) });
    if (message.kind !== "interactive") throw new Error("expected buttons");
    const interactive = message.interactive as Buttons;
    expect(interactive.type).toBe("button");
    expect(interactive.body.text).toBe(
      [
        "✅ Saved! Action 2 is marked done.",
        "",
        "2 actions left:",
        "",
        "1️⃣ Action 1",
        "",
        "3️⃣ Action 3",
        "",
        "✅ When you complete an action, click its button below to update its status as done.",
      ].join("\n")
    );
    expect(interactive.action.buttons.map((button) => button.reply.title)).toEqual(["Action 1 done", "Action 3 done"]);
    expect(parseDonePayload(interactive.action.buttons[1].reply.id)?.actionId).toBe(IDS[2]);
  });

  it("after Action 3 done as well: one left", () => {
    const message = buildCompletionFollowUp({ completion: completed("Action 3"), tappedNumber: 3, actions: states([2, 3]) });
    if (message.kind !== "interactive") throw new Error("expected buttons");
    const interactive = message.interactive as Buttons;
    expect(interactive.body.text).toContain(
      ["1 action left:", "", "1️⃣ Action 1", "", "✅ When you complete it, click the button below to update its status as done."].join("\n")
    );
    expect(interactive.action.buttons.map((button) => button.reply.title)).toEqual(["Action 1 done"]);
  });

  it("shows the next open action's image as the header, and none without one", () => {
    const img = "https://x.supabase.co/storage/v1/object/public/action-images/library/a3.png";
    const withImages = states([1, 2]).map((state) => ({ ...state, imageUrl: state.number === 3 ? img : null }));
    const message = buildCompletionFollowUp({ completion: completed("Action 2"), tappedNumber: 2, actions: withImages });
    if (message.kind !== "interactive") throw new Error("expected buttons");
    expect(message.interactive.header).toEqual({ type: "image", image: { link: img } });

    const plain = buildCompletionFollowUp({ completion: completed("Action 2"), tappedNumber: 2, actions: states([2]) });
    if (plain.kind !== "interactive") throw new Error("expected buttons");
    expect(plain.interactive.header).toBeUndefined();
  });

  it("ends with a plain message once everything is done", () => {
    expect(buildCompletionFollowUp({ completion: completed("Action 1"), tappedNumber: 1, actions: states([1, 2, 3]) })).toEqual({
      kind: "text",
      body: [
        "✅ Saved! Action 1 is marked done.",
        "",
        "🎉 Well done, you've completed all your actions! Keep the momentum going.",
      ].join("\n"),
    });
  });

  it("notes a late completion, but never points or a Surprise Box", () => {
    const message = buildCompletionFollowUp({
      completion: { ...completed("Action 1"), pointsAdded: 0, completedLate: true, surpriseBoxUnlocked: true },
      tappedNumber: 1,
      actions: states([1, 2, 3]),
    });
    if (message.kind !== "text") throw new Error("expected text");
    expect(message.body).toContain("Recorded as completed after its assigned day.");
    expect(message.body).not.toMatch(/points|surprise box/i);
  });

  it("handles repeat taps and actions it can't complete", () => {
    const repeat = buildCompletionFollowUp({
      completion: { outcome: "already_done", title: "Action 2" },
      tappedNumber: 2,
      actions: states([2]),
    });
    if (repeat.kind !== "interactive") throw new Error("expected buttons");
    expect((repeat.interactive as Buttons).body.text).toMatch(/^👍 Action 2 was already marked done/);

    expect(
      buildCompletionFollowUp({ completion: { outcome: "not_assigned", title: null }, tappedNumber: 1, actions: states([]) })
    ).toEqual({ kind: "text", body: expect.stringMatching(/open Nudgeable/) });
  });
});
