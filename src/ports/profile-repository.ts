import type { AttemptReview, LearnerProfile } from "../profile/learner-profile.js";

export interface ProfileRepositoryPort {
  loadLearnerProfile(options?: { baseDir?: string }): Promise<LearnerProfile | null>;
  saveLearnerProfile(profile: LearnerProfile, options?: { baseDir?: string }): Promise<void>;
  applyProfileAttemptEffect(effectId: string, runId: string, review: AttemptReview, options?: { baseDir?: string }): Promise<LearnerProfile>;
}
