// 변경된 Import URL: esm.sh를 사용하여 Named Export 호환성 문제 해결
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// 1. Supabase 클라이언트 초기화
const SUPABASE_URL = 'https://ifdqlwxgqgsvnawmhlfc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlmZHFsd3hncWdzdm5hd21obGZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxODQ3NDIsImV4cCI6MjA4Mjc2MDc0Mn0.UKUvMOl58KuDH24seC3oSgla7mK5lr-vXjqtpalnl6k';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * ElectionService: 선거 관련 모든 데이터 로직을 담당하는 클래스
 */
export class ElectionService {
    
    constructor() {
        this.currentUser = null; // auth.users 정보
        this.memberProfile = null; // coop_members 정보
        this.voterInfo = null; // election_voters 정보 (선거구 포함)
    }

    /**
     * [1] 시스템 초기화 및 사용자 로드
     */
    async initialize() {
        const { data: { user }, error } = await supabase.auth.getUser();
        
        if (error || !user) {
            console.log('비로그인 상태입니다.');
            return null;
        }

        this.currentUser = user;
        
        // 1-2. 조합원 상세 정보 가져오기
        const { data: profile, error: profileError } = await supabase
            .from('coop_members')
            .select('*')
            .eq('id', user.id)
            .single();

        if (profileError) {
            console.error('조합원 정보 로드 실패:', profileError);
            throw new Error('조합원 정보를 찾을 수 없습니다.');
        }

        this.memberProfile = profile;
        return this.memberProfile;
    }

/**
     * [2] 현재 진행 중인 모든 선거 가져오기 (수정됨)
     * - 기존: 최신 1개만 강제 로드 (삭제함)
     * - 변경: OPEN 또는 NOMINATION 상태인 '모든' 선거를 배열로 반환
     */
    async getActiveElections() {
        const { data, error } = await supabase
            .from('elections')
            .select('*')
            .in('status', ['OPEN', 'NOMINATION'])
            .order('created_at', { ascending: false }); // 최신순 정렬은 유지하되 목록 전체 반환

        if (error) {
            console.error('선거 목록 조회 실패:', error);
            return [];
        }
        return data || [];
    }

/**
     * [3] 나의 투표용지 목록 가져오기 (수정됨)
     * - district.is_common: true 이면 리스트의 맨 뒤로 보냅니다.
     * - 무투표 당선 여부(isUncontested)를 판별합니다.
     */
    async getMyBallotList(electionId) {
        if (!this.memberProfile) await this.initialize();

        // 1. 선거인 명부 조회
        const { data: voterList, error: voterError } = await supabase
            .from('election_voters')
            .select('district_id')
            .eq('election_id', electionId)
            .eq('member_uuid', this.memberProfile.id);

        if (voterError || !voterList || voterList.length === 0) {
            throw new Error('귀하는 이번 선거의 선거구에 배정되지 않았습니다.');
        }

        // 2. 상세 정보 병렬 조회
        const ballots = await Promise.all(voterList.map(async (voter) => {
            const districtId = voter.district_id;

            // [수정] districts 테이블에서 is_common 컬럼을 추가로 가져옵니다.
            const { data: district } = await supabase
                .from('districts')
                .select('name, vote_type, quota, is_common') 
                .eq('id', districtId)
                .single();

            // 후보자 목록 조회
            let candidates = [];
            // [중요] BINARY 타입(찬반/추천)은 후보자 조회를 아예 하지 않음 (데이터 오염 방지)
            if (district.vote_type === 'CANDIDATE') {
                const { data: candData } = await supabase
                    .from('candidates')
                    .select('*')
                    .eq('election_id', electionId)
                    .eq('district_id', districtId) // 확실하게 선거구 ID로 필터링
                    .eq('status', 'APPROVED')
                    .order('name', { ascending: true });
                candidates = candData || [];
            }

            // 투표 여부 확인
            const { data: logData } = await supabase
                .from('vote_logs')
                .select('id')
                .eq('election_id', electionId)
                .eq('district_id', districtId)
                .eq('member_uuid', this.memberProfile.id)
                .maybeSingle();

            // [요청] 무투표 당선 여부: 후보자 수 <= 선출 인원 (단, CANDIDATE 타입일 때만)
            const isUncontested = district.vote_type === 'CANDIDATE' && candidates.length > 0 && candidates.length <= district.quota;

            return {
                district_id: districtId,
                district: district,
                candidates: candidates,
                hasVoted: !!logData,
                isUncontested: isUncontested
            };
        }));

        // [요청] 정렬 로직 수정: is_common이 true인 것을 뒤로 보냄
        ballots.sort((a, b) => {
            // 1순위: is_common (false가 앞, true가 뒤)
            if (a.district.is_common !== b.district.is_common) {
                return a.district.is_common ? 1 : -1;
            }
            // 2순위: 이름 가나다순
            return (a.district.name || '').localeCompare(b.district.name || '');
        });

        return ballots;
    }

    /**
     * [4] 투표 제출 (RPC 호출)
     */
    async submitVote({ electionId, districtId, round, candidateId, choice }) {
        const { data, error } = await supabase.rpc('submit_vote', {
            p_election_id: electionId,
            p_district_id: districtId,
            p_round: round,
            p_candidate_id: candidateId || null,
            p_choice: choice || null
        });

        if (error) {
            console.error('투표 제출 에러:', error);
            throw new Error(error.message);
        }

        return true;
    }

// ============================================================
    // [1] 기존 applyCandidate 함수를 이걸로 통째로 교체하세요.
    // ============================================================
    async applyCandidate({ electionId, districtId, name, photoFile, manifesto }) {
        // 1. 로그인된 유저 ID 가져오기
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('로그인 세션이 만료되었습니다. 다시 로그인해주세요.');
        const userId = session.user.id;

        // 2. 사진 업로드 수행 (아래 uploadCandidatePhoto 함수 호출)
        let photoUrl = null;
        try {
            if (photoFile) {
                photoUrl = await this.uploadCandidatePhoto(photoFile, userId);
            } else {
                throw new Error('프로필 사진은 필수입니다.');
            }
        } catch (uploadError) {
            // 업로드 실패 시 더 진행하지 않고 중단
            throw new Error(uploadError.message); 
        }

        // 3. DB에 후보자 정보 저장
        const { data, error } = await supabase
            .from('candidates')
            .insert({
                election_id: electionId,
                district_id: districtId,
                member_uuid: userId,
                name: name,
                photo_url: photoUrl,     // 업로드된 이미지 URL
                manifesto: manifesto,
                status: 'PENDING',       // 승인 대기 상태
                created_at: new Date().toISOString()
            })
            .select();

        if (error) {
            console.error('DB Insert Error:', error);
            throw new Error('신청서 저장 중 오류가 발생했습니다: ' + error.message);
        }

        return data;
    } // End of applyCandidate


    // ============================================================
    // [2] 이 함수를 클래스 내부에 새로 추가하세요. (실제 업로드 로직)
    // ============================================================
    async uploadCandidatePhoto(file, userId) {
        // [중요] Supabase 대시보드 > Storage에 만든 버킷 이름과 토씨 하나 틀리지 않고 똑같아야 합니다.
        const BUCKET_NAME = 'candidates'; 

        // 1. 파일명 난수화 (한글 파일명 오류 방지 및 중복 방지)
        // 예: userId/173000123_xYz123.jpg
        const fileExt = file.name.split('.').pop();
        const randomStr = Math.random().toString(36).substring(2, 10);
        const fileName = `${Date.now()}_${randomStr}.${fileExt}`;
        const filePath = `${userId}/${fileName}`; // 유저 ID 폴더 안에 저장

        // 2. Supabase Storage에 업로드
        const { error: uploadError } = await supabase.storage
            .from(BUCKET_NAME)
            .upload(filePath, file, {
                cacheControl: '3600',
                upsert: false
            });

        if (uploadError) {
            console.error('Storage Upload Error:', uploadError);
            // 버킷이 없을 때 명확한 에러 메시지 전달
            if (uploadError.message.includes('Bucket not found') || uploadError.error === 'Bucket not found') {
                throw new Error(`스토리지 버킷(${BUCKET_NAME})이 존재하지 않습니다. 관리자에게 문의하세요.`);
            }
            throw new Error('사진 업로드 실패: ' + uploadError.message);
        }

        // 3. 업로드된 파일의 공개 URL 가져오기
        const { data } = supabase.storage
            .from(BUCKET_NAME)
            .getPublicUrl(filePath);

        return data.publicUrl;
    } // End of uploadCandidatePhoto
    // [ElectionService.js 클래스 내부에 추가]

    /**
     * 증빙서류 비공개 업로드 (Private Bucket)
     * @param {File} file 
     * @param {string} userId 
     */
    async uploadProofDoc(file, userId) {
        const BUCKET_NAME = 'candidate_proofs'; // Private Bucket

        try {
            // 파일명 난수화
            const fileExt = file.name.split('.').pop();
            const fileName = `${Date.now()}_proof_${Math.random().toString(36).substring(2, 8)}.${fileExt}`;
            const filePath = `${userId}/${fileName}`;

            const { error } = await supabase.storage
                .from(BUCKET_NAME)
                .upload(filePath, file, {
                    upsert: true
                });

            if (error) throw error;

            // Private 버킷은 publicUrl이 없음. 대신 저장된 경로(path)를 리턴하여 DB에 저장.
            // 나중에 다운로드할 때 createSignedUrl(filePath)로 접근해야 함.
            return filePath; 
            
        } catch (e) {
            throw new Error('증빙서류 업로드 실패: ' + e.message);
        }
    }

} // End of ElectionService class
