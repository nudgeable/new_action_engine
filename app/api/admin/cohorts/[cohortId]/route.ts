import { NextResponse } from "next/server";
import { getCohortDetail, getCompanyUsers, listCohortDates } from "@/app/actions/cohorts";
import { getCohortNotices } from "@/app/actions/cohort-notices";
import { listFacilitators } from "@/app/actions/facilitators";
import { getCohortTeamNameOverrides } from "@/app/actions/participant-tags";
import { listActiveLibraryItems, listCohortContent } from "@/app/actions/prepare-content";
import { listTrainers } from "@/app/actions/trainers";
import { getAdminContext } from "@/app/actions/admin-analytics";
import type { Trainer } from "@/lib/types";

export const dynamic = "force-dynamic";

function statusForThrown(message: string) {
  if (message === "Not authenticated") return 401;
  if (message.startsWith("Forbidden")) return 403;
  return 500;
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ cohortId: string }> }
) {
  const { cohortId } = await params;
  const { searchParams } = new URL(request.url);
  const bundle = searchParams.get("bundle");
  const companyId = searchParams.get("companyId");

  try {
    if (bundle === "notices") {
      return json(await getCohortNotices(cohortId));
    }

    if (bundle === "workspace") {
      if (!companyId) return json({ error: "companyId required" }, 400);
      const { role } = await getAdminContext();
      const [
        detailResult,
        usersResult,
        contentResult,
        libraryResult,
        trainersResult,
        noticesResult,
        facilitatorsResult,
        teamNameOverridesResult,
        datesResult,
      ] = await Promise.all([
        getCohortDetail(cohortId),
        getCompanyUsers(companyId),
        listCohortContent(cohortId),
        listActiveLibraryItems(),
        role === "superadmin" ? listTrainers() : Promise.resolve({ trainers: [] as Trainer[], error: undefined as string | undefined }),
        getCohortNotices(cohortId),
        listFacilitators(cohortId),
        // The workspace view's own team list is derived client-side from this
        // cohort's own roster (detailResult.members), not every team used
        // anywhere in the company — only its per-batch overrides come from here.
        getCohortTeamNameOverrides(cohortId),
        listCohortDates(cohortId),
      ]);
      return json({
        error:
          detailResult.error ||
          usersResult.error ||
          contentResult.error ||
          libraryResult.error ||
          trainersResult.error ||
          noticesResult.error ||
          facilitatorsResult.error ||
          teamNameOverridesResult.error ||
          datesResult.error,
        members: detailResult.members ?? [],
        trainerId: detailResult.cohort?.trainerId ?? "",
        senderName: detailResult.cohort?.senderName ?? "",
        maxWeeks: detailResult.cohort?.maxWeeks ?? null,
        emailSubjects: detailResult.cohort?.emailSubjects ?? {},
        actionCategories: detailResult.cohort?.actionCategories ?? [],
        companyUsers: usersResult.users ?? [],
        assignedContentIds: (contentResult.items ?? []).map((item) => item.id),
        libraryItems: libraryResult.items ?? [],
        trainers: trainersResult.trainers ?? [],
        notices: noticesResult.notices ?? [],
        facilitators: facilitatorsResult.facilitators ?? [],
        teamNameOverrides: teamNameOverridesResult.overrides ?? {},
        dates: datesResult.dates ?? [],
      });
    }

    return json(await getCohortDetail(cohortId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return json({ error: message }, statusForThrown(message));
  }
}
