import type { MemberOrder, MemberProfile } from '../domain/member-profile.js';

export type DiscordActor = {
  interactionId: string;
  guildId: string;
  userId: string;
};

export type ProfileBindingStatus = 'provisioning' | 'active';

export type ProfileSnapshot = {
  profileSlug: string;
  stateRevision: string;
  editRevision: string;
  profile: MemberProfile;
  draft?: {
    profile: MemberProfile;
    revision: string;
    baseStateRevision: string;
    isPublishing: boolean;
    stale: boolean;
  };
  pendingPhoto?: {
    stagedPhotoId: string;
    width: number;
    height: number;
    isPublishing: boolean;
    stale: boolean;
  };
  bindingStatus: ProfileBindingStatus;
  lastCommitSha?: string;
  lastDeploymentStatus?: string;
  membersPageUrl?: string;
};

export type ProfileOperationResult = {
  snapshot?: ProfileSnapshot;
  commitSha?: string;
  deploymentStatus?: string;
  queued?: boolean;
  operationId?: string;
};

export type LocalProfileProbe = {
  hasBinding: boolean;
  snapshot: ProfileSnapshot | null;
};

export type EditableProfilePatch = Partial<
  Pick<
    MemberProfile,
    | 'name'
    | 'position'
    | 'order'
    | 'details'
    | 'researchInterests'
    | 'contact'
    | 'website'
    | 'listed'
  >
>;

export type PreparedProfilePhoto = {
  stagedPhotoId: string;
  previewBytes: Uint8Array;
  width: number;
  height: number;
};

export type ProfileService = {
  getOwnProfileLocal(guildId: string, userId: string): LocalProfileProbe;
  getOwnProfile(guildId: string, userId: string): Promise<ProfileSnapshot | null>;
  register(
    actor: DiscordActor,
    input: { name: string; position: string; order: MemberOrder },
  ): Promise<ProfileOperationResult>;
  updateOwnProfile(
    actor: DiscordActor,
    patch: EditableProfilePatch,
    expectedRevision: string,
  ): Promise<ProfileOperationResult>;
  stageOwnProfileDraft(
    actor: DiscordActor,
    patch: EditableProfilePatch,
    expectedRevision: string,
  ): ProfileSnapshot;
  discardOwnProfileDraft(
    actor: DiscordActor,
    expectedDraftRevision: string,
  ): ProfileSnapshot;
  saveOwnProfileDraft(
    actor: DiscordActor,
    expectedDraftRevision: string,
  ): Promise<ProfileOperationResult>;
  saveOwnProfileEdits(
    actor: DiscordActor,
    expectedEditRevision: string,
  ): Promise<ProfileOperationResult>;
  discardOwnProfileEdits(
    actor: DiscordActor,
    expectedEditRevision: string,
  ): ProfileSnapshot;
  prepareOwnPhoto(
    actor: DiscordActor,
    input: { bytes: Uint8Array; filename: string; contentType?: string },
  ): Promise<PreparedProfilePhoto>;
  confirmOwnPhoto(actor: DiscordActor, stagedPhotoId: string): Promise<ProfileOperationResult>;
  acceptOwnPhoto(actor: DiscordActor, stagedPhotoId: string): ProfileSnapshot;
  stageOwnPhotoRemoval(
    actor: DiscordActor,
    expectedEditRevision: string,
  ): ProfileSnapshot;
  discardOwnPhoto(actor: DiscordActor, stagedPhotoId: string): Promise<void>;
  removeOwnPhoto(
    actor: DiscordActor,
    expectedRevision: string,
  ): Promise<ProfileOperationResult>;
  setOwnListed(
    actor: DiscordActor,
    listed: boolean,
    expectedRevision: string,
  ): Promise<ProfileOperationResult>;
};

export type DiscordAttachment = {
  id: string;
  filename: string;
  size: number;
  url: string;
  proxy_url: string;
  content_type?: string;
  width?: number | null;
  height?: number | null;
  ephemeral?: boolean;
};

export type DiscordCommandOption = {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordCommandOption[];
};

export type DiscordResolvedData = {
  users?: Record<string, { id: string; username?: string }>;
  members?: Record<string, Record<string, unknown>>;
  attachments?: Record<string, DiscordAttachment>;
};

export type DiscordModalChild =
  | { type: 4; id?: number; custom_id: string; value: string }
  | { type: 3 | 19 | 22; id?: number; custom_id: string; values: string[] }
  | { type: 21; id?: number; custom_id: string; value: string | null }
  | { type: 23; id?: number; custom_id: string; value: boolean };

export type DiscordModalComponent =
  | { type: 18; id?: number; component: DiscordModalChild }
  | { type: 10; id?: number; content?: string };

export type DiscordInteraction = {
  id: string;
  application_id: string;
  type: number;
  token: string;
  version?: number;
  guild_id?: string;
  member?: { user?: { id?: string } };
  user?: { id?: string };
  data?: {
    name?: string;
    type?: number;
    custom_id?: string;
    component_type?: number;
    values?: string[];
    options?: DiscordCommandOption[];
    resolved?: DiscordResolvedData;
    components?: DiscordModalComponent[];
  };
};

export type DiscordInteractionResponse = {
  type: number;
  data?: Record<string, unknown>;
};

export type DiscordMessagePayload = Record<string, unknown>;

export type DiscordMessageFile = {
  filename: string;
  bytes: Uint8Array;
  contentType?: string;
  description?: string;
};

export type InteractionWebhookClient = {
  editOriginal(
    interactionToken: string,
    payload: DiscordMessagePayload,
    files?: readonly DiscordMessageFile[],
  ): Promise<void>;
};

export type AttachmentDownloader = {
  download(attachment: DiscordAttachment): Promise<Uint8Array>;
};

export type InteractionRouteResult = {
  response: DiscordInteractionResponse;
  /**
   * Run only after the HTTP interaction response has been sent. Mutation routes
   * return a defer response immediately and perform their slow work here.
   */
  afterResponse?: () => Promise<void>;
};
