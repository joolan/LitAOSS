export interface PendingUpload {
  id: string;
  path: string;
  file: File;
  size: number;
}

export type UploadStatus = 'pending' | 'uploading' | 'done' | 'error';

export interface QueueItem extends PendingUpload {
  status: UploadStatus;
  progress: number;
  error?: string;
}
