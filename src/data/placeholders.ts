export type QueueItem = { id: string; filename: string; kind: 'image' | 'video'; color: string; mark: string };

// Purely illustrative entries; they do not represent scanned files or real metadata.
export const placeholderItems: QueueItem[] = [
  { id: 'p1', filename: 'IMG_2048.jpg', kind: 'image', color: '#716b57', mark: '01' },
  { id: 'p2', filename: 'coastline.mov', kind: 'video', color: '#365852', mark: '02' },
  { id: 'p3', filename: 'DSC_0412.jpg', kind: 'image', color: '#7b5e4d', mark: '03' },
  { id: 'p4', filename: 'evening-light.mp4', kind: 'video', color: '#4f536d', mark: '04' },
  { id: 'p5', filename: 'IMG_2051.jpg', kind: 'image', color: '#6c725e', mark: '05' },
  { id: 'p6', filename: 'weekend_07.jpg', kind: 'image', color: '#846b62', mark: '06' },
];

export const placeholderDestinations = ['Favorites', 'Travel', 'Family', 'To review'];
