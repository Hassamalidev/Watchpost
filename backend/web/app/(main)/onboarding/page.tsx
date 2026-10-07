import type { Metadata } from "next";
import { OnboardingWizard } from "@/features/onboarding/components/onboarding-wizard";

export const metadata: Metadata = { title: "Get started" };

export default function OnboardingPage() {
  return (
    <main className="flex min-h-dvh items-start justify-center p-4 sm:items-center">
      <OnboardingWizard />
    </main>
  );
}
