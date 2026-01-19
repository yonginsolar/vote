import { supabase } from './ElectionService.js'; // 기존 설정 재사용

export class AdminService {
    
    // [보안] 관리자 여부 확인 (화면 진입 시 체크용)
    // 실제 보안은 DB RLS가 막아주지만, UX를 위해 1차 체크
// [수정] 관리자 여부 확인 (DB의 is_admin 함수를 직접 호출하여 정확도 100% 확보)
    async isAdmin() {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return false;

        // DB에 정의된 is_admin() 함수 실행
        const { data, error } = await supabase.rpc('is_admin');
        
        // 에러 없고, 결과가 true면 관리자임
        return !error && data; 
    }

    // 1. 선거 정보 및 현재 상태 가져오기
    async getElectionInfo() {
        // 가장 최근 선거 하나만 가져옴
        const { data, error } = await supabase
            .from('elections')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
            
        if (error) throw error;
        return data;
    }

// [수정] 선거 상태 변경 (+ 로그 기록)
    async updateStatus(electionId, newStatus) {
        // 1. 상태 변경
        const { error } = await supabase
            .from('elections')
            .update({ status: newStatus })
            .eq('id', electionId);
            
        if (error) throw new Error('상태 변경 실패: ' + error.message);

        // 2. 로그 기록
        await this.logAction(electionId, 'STATUS_CHANGE', `선거 상태를 ${newStatus}로 변경`);
    }

    // 3. 승인 대기중인 후보자 목록 가져오기
    async getPendingCandidates(electionId) {
        const { data, error } = await supabase
            .from('candidates')
            .select(`*, districts(name)`) // 선거구 이름도 같이
            .eq('election_id', electionId)
            .eq('status', 'PENDING');

        if (error) throw error;
        return data;
    }

    // 4. 후보자 승인/반려 처리
    async reviewCandidate(candidateId, decision) {
        // decision: 'APPROVED' or 'REJECTED'
        const { error } = await supabase
            .from('candidates')
            .update({ status: decision })
            .eq('id', candidateId);
            
        if (error) throw error;
    }

    // 5. [모니터링] 실시간 투표율 집계
    // RLS 때문에 일반 유저는 못 쓰는 쿼리
    async getTurnoutStats(electionId) {
        // 전체 유권자 수 (명부 기준)
        const { count: totalVoters } = await supabase
            .from('election_voters')
            .select('*', { count: 'exact', head: true })
            .eq('election_id', electionId);

        // 투표 참여자 수 (로그 기준)
        const { count: currentVotes } = await supabase
            .from('vote_logs')
            .select('*', { count: 'exact', head: true })
            .eq('election_id', electionId);

        return {
            total: totalVoters || 0,
            current: currentVotes || 0,
            percent: totalVoters ? ((currentVotes / totalVoters) * 100).toFixed(1) : 0
        };
    }

    // 6. [개표] 결과 가져오기 (관리자 전용)
    async getResults(electionId) {
        // 실제로는 DB RPC로 집계하는 게 빠르지만, MVP에서는 JS로 계산
        // 1. 모든 투표용지 가져오기
        const { data: ballots, error } = await supabase
            .from('ballots')
            .select(`
                district_id,
                candidate_id,
                choice,
                districts(name, vote_type),
                candidates(name)
            `)
            .eq('election_id', electionId);

        if (error) throw error;
        return ballots; // 화면에서 가공해서 그림
    }

    // [추가] 로그 기록 함수 (핵심)
    async logAction(electionId, actionType, details) {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;

        await supabase.from('admin_logs').insert({
            election_id: electionId,
            admin_email: user.email,
            action_type: actionType,
            details: details
        });
    }

    // [추가] 로그 목록 가져오기 (최신순 50개)
    async getLogs(electionId) {
        const { data, error } = await supabase
            .from('admin_logs')
            .select('*')
            .eq('election_id', electionId)
            .order('created_at', { ascending: false })
            .limit(50);
        
        if (error) return [];
        return data;
    }

    // [추가] 후보자 목록(기호 포함) 가져오기
    async getCandidates(electionId) {
        const { data, error } = await supabase
            .from('candidates')
            .select(`*, districts(name)`)
            .eq('election_id', electionId)
            .order('district_id', { ascending: true }) // 선거구별 정렬
            .order('symbol', { ascending: true }); // 기호순 정렬

        if (error) throw error;
        return data;
    }

    // [추가] 후보자 승인/반려 (+ 로그)
    async reviewCandidate(candId, decision, candName) {
        const { error } = await supabase
            .from('candidates')
            .update({ status: decision })
            .eq('id', candId);
            
        if (error) throw error;
        
        // 로그 기록 시 electionId가 필요하지만, 
        // 편의상 화면에서 호출 후 별도로 남기거나 여기서 조회해야 함.
        // (MVP에서는 화면단에서 로그 함수를 따로 호출하는 게 빠름)
    }

    // [추가] 후보자 기호 저장
    async updateSymbol(candId, symbol) {
        const { error } = await supabase
            .from('candidates')
            .update({ symbol: symbol })
            .eq('id', candId);
        
        if (error) throw error;
    }
async getElections() {
    const { data, error } = await supabase
        .from('elections')
        .select('*')
        .order('created_at', { ascending: false }); // 최신순

    if (error) {
        console.error('선거 목록 로드 실패:', error);
        return [];
    }
    return data;
}
}
